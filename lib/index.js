import { createRequire } from "node:module";
import { access, appendFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path, { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from "node:path";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import chokidar from "chokidar";
import { WebSocket, WebSocketServer } from "ws";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as pty from "node-pty";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
//#region src/watch.ts
/**
* 与前端展示无关的重目录。node_modules 在仓库根就有 6 千多个文件，不排除的话监听要先白扫一遍。
* 与旧实现（chokidar 的 ignored）保持同一套规则。
*/
const IGNORED = /(^|[/\\])(\.git|node_modules|\.next|\.nuxt|\.turbo|\.vite|coverage)([/\\]|$)/;
/** 「整体重扫」事件的 event 名：路由层看到它就给客户端发 reload。 */
const RESCAN_EVENT = "rescan";
/**
* 原生 fs.watch 的这次回调是不是「事件可能丢了」。
*
* Windows 的 ReadDirectoryChangesW 缓冲溢出时 `filename` 为 null（Linux/macOS 的某些实现也可能给空串）；
* `error` 事件同理 —— 拿不到具体路径，只能认为中间有遗漏。此时必须让上层整体重扫，而不是静默丢弃。
*/
function isWatcherOverflow(event, filename) {
	return event === "error" || typeof filename !== "string" || filename === "";
}
/**
* 连续溢出节流器：窗口内只放行第一次，其余丢弃。
*
* `now` 可注入，测试用假时钟断言（不依赖真 sleep）。
*/
function createRescanThrottle(windowMs = 500, now = () => Date.now()) {
	let last;
	return () => {
		const at = now();
		if (last !== void 0 && at - last < windowMs) return false;
		last = at;
		return true;
	};
}
/**
* 建工作区监听。
*
* 优先用操作系统的递归监听：一次系统调用覆盖整棵树，不需要先遍历。实测同一个工作区
* （约 1.8 万个非 node_modules 文件）原生递归监听建起来只要 0.19ms，而 chokidar 要先遍历
* 一遍、ready 要 3443ms。那 3.4 秒全在宿主进程里 —— 工作台一打开就把共用的宿主占住，
* 实测插件 API 往返延迟从 2ms 冲到 146ms，终端的响应跟着一起抖。
*
* 平台不支持递归监听时（老版本 Node 在 Linux 上会抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM）
* 退回 chokidar，行为与以前一致。
*
* 原生缓冲溢出（filename 为空）或 error 事件不再是「忽略」：向上发一次 `rescan` 信号，
* 由路由层转成「客户端整体重扫」。正常事件的忽略规则与相对路径语义保持不变。
*/
function createWorkspaceWatcher(workspace) {
	const listeners = /* @__PURE__ */ new Set();
	const emit = (event, changed) => {
		for (const listener of [...listeners]) listener(event, changed);
	};
	const allowRescan = createRescanThrottle();
	const signalRescan = () => {
		if (allowRescan()) emit(RESCAN_EVENT, "");
	};
	try {
		const native = watch(workspace, {
			recursive: true,
			persistent: true
		});
		native.on("change", (event, filename) => {
			const name = typeof filename === "string" ? filename : filename === null ? "" : filename.toString();
			if (isWatcherOverflow(event, name)) {
				signalRescan();
				return;
			}
			const changed = relative(workspace, join(workspace, name));
			if (changed === "" || IGNORED.test(changed.split(sep).join("/"))) return;
			emit(event, join(workspace, name));
		});
		native.on("error", () => {
			signalRescan();
		});
		return {
			on: (_event, handler) => {
				listeners.add(handler);
			},
			off: (_event, handler) => {
				listeners.delete(handler);
			},
			close: () => {
				listeners.clear();
				native.close();
			}
		};
	} catch {}
	const fallback = chokidar.watch(workspace, {
		ignoreInitial: true,
		ignored: IGNORED,
		awaitWriteFinish: {
			stabilityThreshold: 100,
			pollInterval: 25
		}
	});
	fallback.on("all", (event, changed) => {
		emit(event, changed);
	});
	fallback.on("error", () => {
		signalRescan();
	});
	return {
		on: (_event, handler) => {
			listeners.add(handler);
		},
		off: (_event, handler) => {
			listeners.delete(handler);
		},
		close: () => {
			listeners.clear();
			fallback.close();
		}
	};
}
//#endregion
//#region src/wire.ts
var WorkbenchError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += value.length;
		if (size > 2097152) throw new WorkbenchError("too-large", "request body is too large", 413);
		chunks.push(value);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("object expected");
		return value;
	} catch {
		throw new WorkbenchError("bad-json", "request body must be a JSON object");
	}
}
/** Read a binary upload while enforcing a fixed request limit. */
async function readBinaryBody(req, limit = 104857600) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += value.length;
		if (size > limit) throw new WorkbenchError("too-large", "uploaded file is too large", 413);
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}
function stringField$1(body, key) {
	const value = body[key];
	if (typeof value !== "string") throw new WorkbenchError("bad-request", `${key} must be a string`);
	return value;
}
function send(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}
function sendError(res, error) {
	const known = error instanceof WorkbenchError ? error : new WorkbenchError("internal", error instanceof Error ? error.message : String(error), 500);
	send(res, known.status, {
		ok: false,
		error: {
			code: known.code,
			message: known.message
		}
	});
}
/**
* 复用 Harness 自己的连接认证与部署感知的 Host/Origin 防线。
*
* 0.2.1 起 webRuntime.trustedHosts 随 runtime 服务一起移除，认证统一由 connection 服务提供；
* 这里不再自建 host 白名单，否则会与宿主（尤其是远程/反代部署）的判断分叉。
* 返回 false 时已经写好响应，调用方直接 return 即可。
*/
function authorize(req, res, connection) {
	const rejection = connection.requestRejection(req);
	if (rejection === void 0) return true;
	const code = rejection === 401 ? "unauthorized" : "forbidden";
	send(res, rejection, {
		ok: false,
		error: {
			code,
			message: code
		}
	});
	return false;
}
//#endregion
//#region src/paths.ts
/**
* 工作区 / 包目录的路径判定。
*
* 从 host.ts 抽出：assets.ts 需要 `inside()`，host.ts 又 re-export assets 的解析函数，
* 两边因此形成循环 import。现在 `inside` 与「相对路径 → 工作区绝对路径」的统一校验都放在这里，
* 依赖方向变为单向：paths.ts ← host.ts / assets.ts / terminal.ts（paths 只依赖 wire.ts 的错误类型）。
*
* 校验顺序固定（两处调用方原本就是这个顺序，逐字保持）：
*   1. 词法解析：`resolve(root, raw)`，落在 root 之外即拒绝；
*   2. `realpath` 展开符号链接；
*   3. 展开后的目标仍在 root 之内（防止 symlink 逃逸）；
*   4. 存在性（use 模式）或父目录存在性（create 模式）；
*   5. 按需要求目标是目录。
*
* 错误码与消息不写死在这里：文件 API（`path-outside`/`not-found`，英文机器文案）与终端
* （`directory-outside`/`directory-not-found`，面向用户的中文文案）共用同一套算法但对外表现
* 不同，所以由调用方传入 `WorkspacePathErrors`。这是唯一允许的差异，校验强度不允许不同。
*/
/** target 是否落在 root 之内（含 root 本身）。原先在 host.ts，assets.ts 也用它守卫包目录。 */
function inside(root, target) {
	const rel = relative(root, target);
	return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
/** 词法越界检查（两种模式共用）：`raw` 为空表示 root 本身。 */
function lexicalPath(root, raw, errors) {
	const absolute = resolve(root, raw === "" ? "." : raw);
	if (!inside(root, absolute)) throw errors.outside(raw);
	return absolute;
}
function notDirectory(errors, raw) {
	return errors.notDirectory?.(raw) ?? new WorkbenchError("not-a-directory", `${raw} is not a directory`);
}
/**
* 解析一个**必须已存在**的工作区相对路径（读/删/重命名源等）。
* 同步版给终端用（TerminalManager 是同步 API），异步版给文件 API 用；算法与判定顺序一致。
*/
async function resolveExistingWorkspacePath(root, raw, errors, options = {}) {
	const absolute = lexicalPath(root, raw, errors);
	let actual;
	try {
		actual = await realpath(absolute);
	} catch {
		throw errors.missing(raw);
	}
	if (!inside(root, actual)) throw errors.symlinkOutside(raw);
	if (options.kind === "directory") {
		let isDirectory;
		try {
			isDirectory = (await stat(actual)).isDirectory();
		} catch {
			throw errors.missing(raw);
		}
		if (!isDirectory) throw notDirectory(errors, raw);
	}
	return {
		absolute,
		actual
	};
}
function resolveExistingWorkspacePathSync(root, raw, errors, options = {}) {
	const absolute = lexicalPath(root, raw, errors);
	let actual;
	try {
		actual = realpathSync(absolute);
	} catch {
		throw errors.missing(raw);
	}
	if (!inside(root, actual)) throw errors.symlinkOutside(raw);
	if (options.kind === "directory") {
		let isDirectory;
		try {
			isDirectory = statSync(actual).isDirectory();
		} catch {
			throw errors.missing(raw);
		}
		if (!isDirectory) throw notDirectory(errors, raw);
	}
	return {
		absolute,
		actual
	};
}
/**
* 解析一个**允许不存在**的目标（新建/上传/重命名目标等）：只要求父目录存在且仍在工作区内，
* 目标本身留给后续 open/mkdir/rename 去创建。父目录经 realpath 展开，防止借符号链接越界。
*/
async function resolveCreatableWorkspacePath(root, raw, errors) {
	const absolute = lexicalPath(root, raw, errors);
	let parent;
	try {
		parent = await realpath(dirname(absolute));
	} catch {
		throw errors.missing(raw);
	}
	if (!inside(root, parent)) throw errors.symlinkOutside(raw);
	return { absolute };
}
//#endregion
//#region src/assets.ts
const require$1 = createRequire(import.meta.url);
/**
* 静态资源的解析：把这些第三方包里的文件按受限路径取出来交给路由层提供。
* 从 host.ts 拆出 —— 这一组只依赖包路径与路径包含判断，与工作区的文件系统操作无关。
* 形如 (raw: string) 的入参来自 URL，都要经 inside() 确认没有越出包目录。
*/
/** Resolve the official VS Code Codicon font shipped by @vscode/codicons. */
function codiconAsset() {
	const packageRoot = dirname(require$1.resolve("@vscode/codicons/package.json"));
	return {
		path: resolve(packageRoot, "dist", "codicon.ttf"),
		type: "font/ttf"
	};
}
/** Monaco 的构建目录：min 是运行时用的那份，dev/esm 只在 min 缺文件时兜底。 */
const MONACO_BUILDS = [
	"min",
	"dev",
	"esm"
];
function monacoAsset(raw) {
	const packageRoot = dirname(require$1.resolve("monaco-editor/package.json"));
	const root = resolve(packageRoot, MONACO_BUILDS[0]);
	const requested = resolve(root, raw);
	if (!inside(root, requested)) throw new WorkbenchError("asset-invalid", "invalid Monaco asset path", 403);
	let path = requested;
	let found = existsSync(requested);
	if (!found) for (const build of MONACO_BUILDS.slice(1)) {
		const candidate = resolve(packageRoot, build, raw);
		if (!inside(resolve(packageRoot, build), candidate)) continue;
		if (existsSync(candidate)) {
			console.warn(`[dsh-completion] Monaco 资源 min 构建缺失，改用 ${build}：${raw}`);
			path = candidate;
			found = true;
			break;
		}
	}
	if (!found) {
		console.warn(`[dsh-completion] Monaco 资源在 ${MONACO_BUILDS.join("/")} 中都不存在：${raw}`);
		throw new WorkbenchError("asset-missing", `Monaco asset not found: ${raw}`, 404);
	}
	const type = extname(path) === ".css" ? "text/css" : extname(path) === ".js" ? "text/javascript" : extname(path) === ".ttf" ? "font/ttf" : "application/octet-stream";
	return {
		path,
		type
	};
}
/**
* Resolve vscode-oniguruma's WASM binary —— TextMate 语法背后的正则引擎。
* 走 HTTP 提供，客户端用 fetch + WebAssembly 加载。
*/
function onigWasmAsset() {
	const packageRoot = dirname(require$1.resolve("vscode-oniguruma/package.json"));
	return {
		path: resolve(packageRoot, "release", "onig.wasm"),
		type: "application/wasm"
	};
}
/**
* Resolve one file-type icon from material-icon-theme (the theme VS Code ships by default).
* The explorer renders these as <img>, so only the SVG files are served; the name→file mapping
* lives in the client bundle (see scripts/generate-file-icons.mjs).
*/
function fileIconAsset(raw) {
	const packageRoot = dirname(require$1.resolve("material-icon-theme/package.json"));
	const path = resolve(packageRoot, "icons", raw);
	if (!inside(resolve(packageRoot, "icons"), path)) throw new WorkbenchError("asset-invalid", "invalid file icon path", 403);
	return {
		path,
		type: extname(path) === ".svg" ? "image/svg+xml" : "application/octet-stream"
	};
}
/**
* Resolve KaTeX's stylesheet and web fonts. katex.min.css references its fonts with the
* relative url "fonts/…", so the stylesheet and the font directory must be served under one
* prefix for the browser to resolve them.
*/
function katexAsset(raw) {
	const packageRoot = dirname(require$1.resolve("katex/package.json"));
	const path = resolve(packageRoot, "dist", raw);
	if (!inside(resolve(packageRoot, "dist"), path)) throw new WorkbenchError("asset-invalid", "invalid KaTeX asset path", 403);
	const extension = extname(path);
	return {
		path,
		type: extension === ".css" ? "text/css" : extension === ".woff2" ? "font/woff2" : extension === ".woff" ? "font/woff" : extension === ".ttf" ? "font/ttf" : "application/octet-stream"
	};
}
/**
* 读取一份 shiki 的 TextMate 语法，返回它的原始 JSON。
*
* 之所以要这样取：@shikijs/langs 的每个语法模块只是 `JSON.parse("…")` 的包装，
* 而 vscode-textmate 的 loadGrammar 收的正是这个 JSON 对象。把语法留在宿主侧按需提供，
* 客户端就不必把它们打进 bundle —— 全部语法合计约 2.5MB（cpp 一份 521KB、cpp-macro 296KB、
* 还有 ts/js/jsx/tsx/objc-cpp/php/less/csharp/swift… 各数十至上百 KB），
* 这是客户端体积的最大来源。
*
* 入参来自 URL，先经 inside() 确认没有越出包目录。
*/
async function readGrammar(raw) {
	const root = dirname(require$1.resolve("@shikijs/langs"));
	const path = resolve(root, raw);
	if (!inside(root, path)) throw new WorkbenchError("asset-invalid", "invalid grammar path", 403);
	const source = await readFile(path, "utf8");
	const match = /JSON\.parse\("([\s\S]*)"\)/.exec(source);
	if (match === null) throw new WorkbenchError("asset-invalid", "unexpected grammar format", 500);
	return JSON.parse(JSON.parse(`"${match[1]}"`));
}
//#endregion
//#region src/host.ts
const require = createRequire(import.meta.url);
/** 超过这个大小就不再读全文（即使调用方带了 force）。 */
const HARD_READ_LIMIT = 67108864;
const TEXT_LIMIT = 5242880;
const PROCESS_TIMEOUT = 3e4;
function cwdFor(ctx, sessionId) {
	const session = ctx.sessions.get(sessionId);
	if (session === void 0) throw new WorkbenchError("session-unknown", "session is not ready yet; retry once it exists", 409);
	const cwd = ctx.workingDirectory.get(session);
	if (cwd === void 0 || cwd === "") throw new WorkbenchError("session-unknown", "session is not ready yet; retry once it exists", 409);
	if (!isAbsolute(cwd)) throw new WorkbenchError("cwd-invalid", "session working directory is not absolute");
	return normalize(cwd);
}
/** 文件 API 的错误码与消息；与重构前逐字一致（tests/host.spec.ts 依赖这些 code）。 */
const PATH_ERRORS = {
	outside: () => new WorkbenchError("path-outside", "path is outside the workspace", 403),
	symlinkOutside: () => new WorkbenchError("path-outside", "path follows a symlink outside the workspace", 403),
	missing: () => new WorkbenchError("not-found", "path does not exist", 404)
};
/** create 模式只要求父目录存在，父目录缺失是独立错误码（与重构前一致）。 */
const PARENT_PATH_ERRORS = {
	...PATH_ERRORS,
	missing: () => new WorkbenchError("parent-missing", "parent directory does not exist", 404)
};
async function canonicalRoot(cwd) {
	return realpath(cwd).catch(() => {
		throw new WorkbenchError("cwd-missing", "session working directory does not exist", 404);
	});
}
/** Resolve a caller-relative path and reject traversal and symlink escape. */
async function workspacePath(cwd, raw, create = false) {
	if (isAbsolute(raw)) throw new WorkbenchError("path-invalid", "absolute paths are not accepted");
	const root = await canonicalRoot(cwd);
	const { absolute } = create ? await resolveCreatableWorkspacePath(root, raw, PARENT_PATH_ERRORS) : await resolveExistingWorkspacePath(root, raw, PATH_ERRORS);
	return {
		root,
		absolute
	};
}
function relativePath(root, absolute) {
	return relative(root, absolute).split(sep).join("/");
}
function revision(content, mtimeMs) {
	return createHash("sha256").update(content).update(String(mtimeMs)).digest("hex");
}
async function listFiles(cwd, path) {
	const { root, absolute } = await workspacePath(cwd, path);
	const values = await readdir(absolute, { withFileTypes: true });
	return (await Promise.all(values.filter((item) => item.name !== ".git").map(async (item) => {
		const full = join(absolute, item.name);
		if (!item.isSymbolicLink()) return {
			name: item.name,
			path: relativePath(root, full),
			kind: item.isDirectory() ? "directory" : "file"
		};
		const actual = await realpath(full).catch(() => void 0);
		if (actual === void 0 || !inside(root, actual)) return void 0;
		const info = await stat(full);
		const kind = info.isDirectory() ? "directory" : "file";
		return {
			name: item.name,
			path: relativePath(root, full),
			kind,
			size: info.size,
			mtimeMs: info.mtimeMs
		};
	}))).filter((row) => row !== void 0).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
}
const QUICK_OPEN_IGNORED_DIRS = /* @__PURE__ */ new Set([
	".git",
	".dsh-workbench",
	"node_modules",
	"bower_components",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".vite",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"target",
	"vendor",
	".idea"
]);
/** 上限按「面板里真要能翻得动」定：再多也只是给人看的列表，不是索引。 */
const FILE_LIST_LIMIT = 5e4;
/** 5 秒：拖文件、新建文件之后立刻再开面板时拿到的是新结果，又不会每按一次 Ctrl+P 就重扫。 */
const FILE_LIST_TTL_MS = 5e3;
const fileListCache = /* @__PURE__ */ new Map();
function listWorkspaceFiles(cwd, now = Date.now()) {
	const key = normalize(cwd);
	const cached = fileListCache.get(key);
	if (cached !== void 0 && now - cached.at <= FILE_LIST_TTL_MS) return cached.value;
	const value = walkWorkspaceFiles(key);
	value.catch(() => {
		if (fileListCache.get(key)?.value === value) fileListCache.delete(key);
	});
	fileListCache.set(key, {
		at: now,
		value
	});
	return value;
}
async function walkWorkspaceFiles(root) {
	const started = Date.now();
	const files = [];
	let truncated = false;
	const walk = async (directory, depth) => {
		if (truncated) return;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (truncated) return;
			if (entry.isDirectory()) {
				if (depth >= 24 || QUICK_OPEN_IGNORED_DIRS.has(entry.name)) continue;
				await walk(join(directory, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
			if (files.length >= FILE_LIST_LIMIT) {
				truncated = true;
				return;
			}
		}
	};
	await walk(root, 0);
	files.sort();
	return {
		files,
		truncated,
		durationMs: Date.now() - started
	};
}
async function readDocument(cwd, path, force = false) {
	const { root, absolute } = await workspacePath(cwd, path);
	const info = await stat(absolute);
	if (!info.isFile()) throw new WorkbenchError("not-file", "path is not a file");
	const tooLarge = info.size > TEXT_LIMIT && !force;
	if (!tooLarge && info.size > HARD_READ_LIMIT) throw new WorkbenchError("too-large", `file is larger than ${HARD_READ_LIMIT / 1048576} MiB`, 413);
	const handle = await open(absolute, "r");
	try {
		const head = Buffer.alloc(Math.min(info.size, tooLarge ? 4096 : info.size));
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const bytes = head.subarray(0, bytesRead);
		const binary = bytes.includes(0);
		return {
			path: relativePath(root, absolute),
			content: binary || tooLarge ? "" : bytes.toString("utf8"),
			revision: revision(bytes, info.mtimeMs),
			size: info.size,
			binary,
			tooLarge
		};
	} finally {
		await handle.close();
	}
}
async function saveDocument(cwd, path, content, expected) {
	const { absolute } = await workspacePath(cwd, path);
	if ((await readDocument(cwd, path)).revision !== expected) throw new WorkbenchError("revision-conflict", "file changed on disk; reload before saving", 409);
	await writeAtomic(absolute, content);
	return readDocument(cwd, path);
}
/**
* 审查还原/检查点回滚用：按内容写回工作区文件（`content` 为 null 时删除）。
*
* 不校验 revision：还原的目标是「回到某个已知内容」，磁盘上的当前内容正是要被覆盖的东西。
* 仍然走 workspacePath 的根目录约束，写入仍然原子 —— 半截文件比还原失败更难收拾。
*/
async function restoreDocument(cwd, path, content) {
	const { absolute } = await workspacePath(cwd, path, true);
	if (content === null) {
		await rm(absolute, { force: true });
		return;
	}
	await mkdir(dirname(absolute), { recursive: true });
	await writeAtomic(absolute, content);
}
/**
* 原子写：同目录临时文件 + rename。
*
* 搜索替换要一次改很多文件，用户也可能正开着其中几个；直接 writeFile 在进程被中断时
* 会留下半截文件，而 rename 在同一文件系统内是原子的（保存文档也走这里）。
*/
async function writeAtomic(absolute, content) {
	const temp = join(dirname(absolute), `.${randomUUID()}.dsh-vscode.tmp`);
	await writeFile(temp, content, {
		encoding: "utf8",
		flag: "wx"
	});
	try {
		await rename(temp, absolute);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}
async function createEntry(cwd, path, kind) {
	const { absolute } = await workspacePath(cwd, path, true);
	if (kind === "directory") await mkdir(absolute);
	else await (await open(absolute, "wx")).close();
}
/** Write an uploaded file into an existing workspace directory without overwriting files. */
async function uploadFile(cwd, directory, name, content) {
	if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new WorkbenchError("filename-invalid", "uploaded file name is invalid");
	const { root, absolute } = await workspacePath(cwd, directory === "" ? name : `${directory}/${name}`, true);
	const handle = await open(absolute, "wx");
	try {
		await handle.writeFile(content);
	} finally {
		await handle.close();
	}
	const info = await lstat(absolute);
	return {
		name,
		path: relativePath(root, absolute),
		kind: "file",
		size: info.size,
		mtimeMs: info.mtimeMs
	};
}
async function renameEntry(cwd, path, nextPath) {
	const source = await workspacePath(cwd, path);
	const target = await workspacePath(cwd, nextPath, true);
	await access(target.absolute, constants.F_OK).then(() => {
		throw new WorkbenchError("target-exists", "destination already exists", 409);
	}, () => void 0);
	await rename(source.absolute, target.absolute);
}
async function deleteEntry(cwd, path) {
	if (path === "") throw new WorkbenchError("root-delete", "cannot delete workspace root", 403);
	const { absolute } = await workspacePath(cwd, path);
	await rm(absolute, {
		recursive: true,
		force: false
	});
}
/**
* 把工作区里的文件或目录复制到另一个目录下（保持原名）。
*
* 三个约束，都是为了「粘错了还能救」：
*   - 目标已存在就报 409，绝不覆盖 —— 这里没有撤销，覆盖等于静默毁掉对方的文件；
*   - 目录不能粘进自己的子目录（否则 node 的 cp 会无限递归，或留下半份副本）；
*   - 目标目录必须已存在（workspacePath 的 create 分支会校验父目录），不替用户顺手建目录。
*/
async function copyEntry(cwd, source, directory) {
	if (source === "") throw new WorkbenchError("path-invalid", "source path is required");
	const from = await workspacePath(cwd, source);
	const name = basename(source);
	const to = await workspacePath(cwd, directory === "" ? name : `${directory}/${name}`, true);
	if (from.absolute === to.absolute || inside(from.absolute, to.absolute)) throw new WorkbenchError("copy-into-self", "cannot copy a directory into itself", 400);
	await access(to.absolute, constants.F_OK).then(() => {
		throw new WorkbenchError("target-exists", "destination already exists", 409);
	}, () => void 0);
	await cp(from.absolute, to.absolute, {
		recursive: true,
		errorOnExist: true,
		force: false,
		preserveTimestamps: true
	});
	const info = await stat(to.absolute);
	return {
		name,
		path: relativePath(to.root, to.absolute),
		kind: info.isDirectory() ? "directory" : "file",
		size: info.size,
		mtimeMs: info.mtimeMs
	};
}
/**
* 把工作区里的文件或目录移动到另一个目录下（保持原名），即资源管理器的「剪切 → 粘贴」。
*
* 约束与 copyEntry 一致（不覆盖、不移入自身、目标目录必须已存在），另外这里用 `rename` 而不是
* 「复制再删除」：同一块盘上的 rename 是原子的，中途失败不会留下「源已删、目标只有一半」的状态。
* 跨盘时 rename 会抛 EXDEV，宁可把错误报给用户，也不静默退化成慢且非原子的复制。
*/
async function moveEntry(cwd, source, directory) {
	if (source === "") throw new WorkbenchError("path-invalid", "source path is required");
	const from = await workspacePath(cwd, source);
	const name = basename(source);
	const to = await workspacePath(cwd, directory === "" ? name : `${directory}/${name}`, true);
	await access(to.absolute, constants.F_OK).then(() => {
		throw new WorkbenchError("target-exists", "destination already exists", 409);
	}, () => void 0);
	if (from.absolute === to.absolute || inside(from.absolute, to.absolute)) throw new WorkbenchError("copy-into-self", "cannot move a directory into itself", 400);
	await rename(from.absolute, to.absolute);
	const info = await stat(to.absolute);
	return {
		name,
		path: relativePath(to.root, to.absolute),
		kind: info.isDirectory() ? "directory" : "file",
		size: info.size,
		mtimeMs: info.mtimeMs
	};
}
const PREVIEW_TYPES = {
	".avif": "image/avif",
	".bmp": "image/bmp",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".odt": "application/vnd.oasis.opendocument.text"
};
/** Resolve a supported preview file inside the workspace. */
async function workspacePreviewFile(cwd, path) {
	const resolved = await workspacePath(cwd, path);
	const type = PREVIEW_TYPES[extname(resolved.absolute).toLowerCase()];
	if (type === void 0) throw new WorkbenchError("unsupported-media", "file is not a supported preview format", 415);
	return {
		path: resolved.absolute,
		type
	};
}
/** Resolve the PDF.js worker shipped with this plugin's runtime dependency. */
function pdfWorkerAsset() {
	return {
		path: require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
		type: "text/javascript; charset=utf-8"
	};
}
/**
* spawn 一个进程并收集输出。
*
* `maxStdoutBytes` 用于搜索这类可能产生巨量输出的调用：超过上限就 kill 子进程并返回已收到的前缀
* （`truncated: true`，前缀末尾可能是半行，调用方自己跳过）。git 调用不传该参数，行为与以前一致。
*/
function run(command, args, cwd, timeout = PROCESS_TIMEOUT, signal, maxStdoutBytes = Number.POSITIVE_INFINITY) {
	return new Promise((resolvePromise, reject) => {
		const env = command === "git" ? {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0"
		} : void 0;
		const child = spawn(command, args, {
			cwd,
			shell: false,
			windowsHide: true,
			...env === void 0 ? {} : { env }
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let truncated = false;
		let settled = false;
		const timer = setTimeout(() => {
			child.kill();
			if (!settled) reject(new WorkbenchError("timeout", `${command} timed out`, 504));
		}, timeout);
		const abort = () => {
			child.kill();
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new WorkbenchError("cancelled", `${command} cancelled`, 499));
			}
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => {
			if (truncated || settled) return;
			const text = String(chunk);
			const bytes = Buffer.byteLength(text);
			if (stdoutBytes + bytes > maxStdoutBytes) {
				const remaining = Math.max(0, maxStdoutBytes - stdoutBytes);
				stdout += Buffer.from(text).subarray(0, remaining).toString("utf8");
				stdoutBytes += remaining;
				truncated = true;
				child.kill();
				return;
			}
			stdout += text;
			stdoutBytes += bytes;
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (!settled) {
				settled = true;
				resolvePromise({
					stdout,
					stderr,
					code: code ?? 1,
					truncated
				});
			}
		});
	});
}
/** 全局匹配条数默认上限：与旧实现一致（客户端据此显示「结果已截断到 2000 条」）。 */
const SEARCH_MAX_MATCHES = 2e3;
/** 单次 rg 的 stdout 字节上限：大仓里 `--max-count` 按文件计，不设总量会把上百 MB 拼进内存。 */
const SEARCH_MAX_OUTPUT_BYTES = 2097152;
/** 单文件大小上限：跳过压缩产物、大日志这类不该参与搜索的文件。 */
const SEARCH_MAX_FILE_BYTES = 2097152;
function positiveLimit(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}
/**
* rg 输出的路径归一成工作区相对路径（正斜杠）。
*
* rg 把命令行里的 `.` 原样拼在路径前：POSIX 上是 `./src/a.ts`，Windows 上是 `.\src\a.ts`，
* 所以前缀两种分隔符都要剥；Windows 的分隔符再统一成正斜杠，客户端（含标签页/资源管理器）
* 只认一种写法。POSIX 上的反斜杠是合法文件名字符，不能动。
*/
function ripgrepRelative(value) {
	const stripped = value.replace(/^\.[\\/]/, "");
	return sep === "\\" ? stripped.split("\\").join("/") : stripped;
}
async function searchWorkspace(cwd, request, signal, runner = run) {
	if (request.query === "") return {
		matches: [],
		limited: false,
		truncated: false
	};
	const root = await canonicalRoot(cwd);
	const rg = require("@vscode/ripgrep").rgPath;
	const maxMatches = positiveLimit(request.maxMatches, SEARCH_MAX_MATCHES);
	const maxOutputBytes = positiveLimit(request.maxOutputBytes, SEARCH_MAX_OUTPUT_BYTES);
	const maxFileSize = positiveLimit(request.maxFileSize, SEARCH_MAX_FILE_BYTES);
	const args = [
		"--json",
		"--line-number",
		"--column",
		"--hidden",
		"--glob",
		"!.git/**",
		"--max-count",
		"2000",
		"--max-filesize",
		String(maxFileSize)
	];
	if (!request.regex) args.push("--fixed-strings");
	if (!request.caseSensitive) args.push("--ignore-case");
	if (request.wholeWord) args.push("--word-regexp");
	if (request.include) args.push("--glob", request.include);
	if (request.exclude) args.push("--glob", `!${request.exclude}`);
	args.push("--", request.query, ".");
	const result = await runner(rg, args, root, PROCESS_TIMEOUT, signal, maxOutputBytes);
	if (!result.truncated && result.code > 1) throw new WorkbenchError("search-failed", result.stderr || "ripgrep failed", 500);
	const matches = [];
	for (const line of result.stdout.split("\n")) {
		if (line === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "match" || event.data?.path?.text === void 0 || event.data.lines?.text === void 0) continue;
		for (const hit of event.data.submatches ?? []) {
			matches.push({
				path: ripgrepRelative(event.data.path.text),
				line: event.data.line_number ?? 1,
				column: hit.start + 1,
				preview: event.data.lines.text.trimEnd(),
				match: hit.match?.text ?? ""
			});
			if (matches.length >= maxMatches) return {
				matches,
				limited: true,
				truncated: true
			};
		}
	}
	return {
		matches,
		limited: result.truncated,
		truncated: result.truncated
	};
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* 把搜索参数编译成与 ripgrep 语义对齐的全局 RegExp。
*
* - `regex=false` 时查询串转义成字面量；
* - `wholeWord` 用 `\b` 包裹（rg 的 --word-regexp 也是词边界语义）；
* - `caseSensitive=false` 加 `i` 标志。
* 正则写错时抛 invalid-regex：客户端在输入时就校验过，这里是服务端兜底。
*/
function compileSearchPattern(request) {
	const source = request.regex === true ? request.query : escapeRegExp(request.query);
	const body = request.wholeWord === true ? `\\b(?:${source})\\b` : source;
	try {
		return new RegExp(body, request.caseSensitive === true ? "g" : "gi");
	} catch (error) {
		throw new WorkbenchError("invalid-regex", error instanceof Error ? error.message : "invalid regular expression");
	}
}
/**
* VS Code 的「保留大小写」：按命中文本的形态改写替换结果。
*
* 只识别三种可判定形态（全大写 / 全小写 / 首字母大写），其余保持替换文本原样；
* 逐词首字母大写（Title Case）的分支在这里刻意不做 —— 对中文与混合标识符都会给出意外结果。
*/
function matchCase(matched, replacement) {
	if (matched === "" || replacement === "") return replacement;
	const upper = matched.toUpperCase();
	const lower = matched.toLowerCase();
	if (matched === upper && matched !== lower) return replacement.toUpperCase();
	if (matched === lower && matched !== upper) return replacement.toLowerCase();
	if (upper.charAt(0) === matched.charAt(0)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
	return replacement;
}
/** 一行的替换结果；`replacements` 用于汇总替换总数。 */
function replaceLine(line, pattern, replacement, preserveCase) {
	let replacements = 0;
	return {
		line: line.replace(pattern, (matched) => {
			replacements++;
			const value = matched.replace(pattern, replacement);
			return preserveCase ? matchCase(matched, value) : value;
		}),
		replacements
	};
}
/**
* 按行替换全文，保留原有行分隔符（CRLF 文件不会被改写成 LF）。
*
* 按行而不是整篇：ripgrep 是行内匹配，整篇替换会让 `^`/`$`/`\s` 这类元字符跨行，
* 与「搜索结果里看到的那些命中」不再是同一批。
*/
function replaceInText(text, pattern, replacement, preserveCase = false) {
	if (text === "") return {
		text,
		replacements: 0
	};
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	let replacements = 0;
	return {
		text: text.split(eol).map((line) => {
			const result = replaceLine(line, pattern, replacement, preserveCase);
			replacements += result.replacements;
			return result.line;
		}).join(eol),
		replacements
	};
}
/**
* 只替换「某一行某一列」的那一处命中（VS Code 结果行上的单条替换）。
*
* 行列来自上一次搜索的结果，磁盘上的内容可能已经变了：这里要求该列上确实还有一个
* 与 pattern 匹配的命中，否则返回 0 处（调用方据此提示「文件已变化」）。
*/
function replaceSingleInText(text, pattern, replacement, preserveCase, lineNumber, column) {
	if (text === "" || lineNumber < 1 || column < 1) return {
		text,
		replacements: 0
	};
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(eol);
	const index = lineNumber - 1;
	if (index >= lines.length) return {
		text,
		replacements: 0
	};
	const target = lines[index] ?? "";
	pattern.lastIndex = 0;
	let match;
	while ((match = pattern.exec(target)) !== null) {
		if (match.index === column - 1) {
			const value = match[0].replace(pattern, replacement);
			const replaced = preserveCase ? matchCase(match[0], value) : value;
			lines[index] = target.slice(0, match.index) + replaced + target.slice(match.index + match[0].length);
			return {
				text: lines.join(eol),
				replacements: 1
			};
		}
		if (match.index > column - 1) break;
		if (match[0] === "") pattern.lastIndex++;
	}
	return {
		text,
		replacements: 0
	};
}
/**
* 工作区替换。
*
* - 传了 `only` 就只改那一处，不再跑 ripgrep（结果行上的单条替换）；
* - 否则 `rg --files-with-matches` 先取文件清单，再逐文件按行替换。
*   为什么用 -l 而不是复用 searchWorkspace：替换全部命中不该被「2000 条匹配上限」截断。
* 所有写入都走 writeAtomic，二进制文件与超限文件跳过（rg 侧已按 .gitignore/大小过滤）。
*/
async function replaceInWorkspace(cwd, request, signal, runner = run) {
	if (request.query === "") throw new WorkbenchError("bad-request", "query is required");
	if (typeof request.replace !== "string") throw new WorkbenchError("bad-request", "replace must be a string");
	const only = request.only;
	if (only !== void 0 && (typeof only !== "object" || only === null || typeof only.path !== "string" || typeof only.line !== "number" || typeof only.column !== "number")) throw new WorkbenchError("bad-request", "only must be { path, line, column }");
	const pattern = compileSearchPattern(request);
	const preserveCase = request.preserveCase === true;
	const files = [];
	let replacements = 0;
	if (request.only !== void 0) {
		const { path, line, column } = request.only;
		const { absolute } = await workspacePath(cwd, path);
		const result = replaceSingleInText(await readFile(absolute, "utf8"), pattern, request.replace, preserveCase, line, column);
		if (result.replacements > 0) {
			await writeAtomic(absolute, result.text);
			files.push(path);
			replacements = result.replacements;
		}
		return {
			files,
			replacements
		};
	}
	const root = await canonicalRoot(cwd);
	const rg = require("@vscode/ripgrep").rgPath;
	const maxFileSize = positiveLimit(request.maxFileSize, SEARCH_MAX_FILE_BYTES);
	const args = [
		"--files-with-matches",
		"--null",
		"--hidden",
		"--glob",
		"!.git/**",
		"--max-filesize",
		String(maxFileSize)
	];
	if (!request.regex) args.push("--fixed-strings");
	if (!request.caseSensitive) args.push("--ignore-case");
	if (request.wholeWord) args.push("--word-regexp");
	if (request.include) args.push("--glob", request.include);
	if (request.exclude) args.push("--glob", `!${request.exclude}`);
	args.push("--", request.query, ".");
	const listed = await runner(rg, args, root, PROCESS_TIMEOUT, signal, SEARCH_MAX_OUTPUT_BYTES);
	if (listed.code > 1) throw new WorkbenchError("search-failed", listed.stderr || "ripgrep failed", 500);
	for (const entry of listed.stdout.split("\0")) {
		const path = ripgrepRelative(entry.replace(/\r?\n$/, ""));
		if (path === "") continue;
		if (signal?.aborted === true) break;
		const { absolute } = await workspacePath(cwd, path);
		const text = await readFile(absolute, "utf8");
		if (text.includes("\0")) continue;
		const result = replaceInText(text, pattern, request.replace, preserveCase);
		if (result.replacements === 0) continue;
		await writeAtomic(absolute, result.text);
		files.push(path);
		replacements += result.replacements;
	}
	return {
		files,
		replacements
	};
}
/**
* 每个 workspace 只跑一次 `rev-parse --show-toplevel`：一次面板 refresh / 一次动作里的
* gitStatus、gitAction、gitObject 都复用同一个仓库根。失败不缓存（变为 git 仓库后可以重试）。
* 进程生命周期内工作区被移动/删除时缓存会过期 —— 与审计报告一致的已知取舍。
*/
const gitRootCaches = /* @__PURE__ */ new WeakMap();
function gitRootCacheFor(runner) {
	let cache = gitRootCaches.get(runner);
	if (cache === void 0) {
		cache = /* @__PURE__ */ new Map();
		gitRootCaches.set(runner, cache);
	}
	return cache;
}
async function gitRoot(cwd, runner = run) {
	const cache = gitRootCacheFor(runner);
	const cached = cache.get(cwd);
	if (cached !== void 0) return cached;
	const pending = (async () => {
		const result = await runner("git", ["rev-parse", "--show-toplevel"], cwd);
		if (result.code !== 0) throw new WorkbenchError("not-repository", "current workspace is not inside a Git repository", 404);
		return result.stdout.trim();
	})();
	cache.set(cwd, pending);
	pending.catch(() => {
		if (cache.get(cwd) === pending) cache.delete(cwd);
	});
	return pending;
}
function validateCommitHash(value) {
	if (!/^[0-9a-f]{7,64}$/i.test(value ?? "")) throw new WorkbenchError("bad-request", "commit hash is invalid");
	return value;
}
function validateGitPath(repository, path) {
	if (path === void 0 || path === "" || isAbsolute(path) || !inside(repository, resolve(repository, path))) throw new WorkbenchError("bad-request", "repository-relative path is required");
	return path;
}
async function gitObject(repository, spec, runner = run) {
	const result = await runner("git", [
		"show",
		"--no-textconv",
		spec
	], repository);
	return result.code === 0 ? result.stdout : "";
}
/**
* 一次提交的文件列表 + 父提交探测结果。
*
* `commit.files` 只要 files；`commit.file.diff` 还要 parent 来决定用 diff 还是 show、以及拿
* `previousPath`/`status`。两处共用同一次 `rev-parse hash^1`，避免 commit.file.diff 里重复探测。
*/
async function commitFilesWithParent(repository, hash, runner = run) {
	const parent = await runner("git", [
		"rev-parse",
		"--verify",
		`${hash}^1`
	], repository);
	const result = parent.code === 0 ? await runner("git", [
		"diff",
		"--name-status",
		"-z",
		"-M",
		parent.stdout.trim(),
		hash,
		"--"
	], repository) : await runner("git", [
		"diff-tree",
		"--root",
		"--no-commit-id",
		"--name-status",
		"-r",
		"-z",
		"-M",
		hash
	], repository);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
	return {
		files: parseNameStatus(result.stdout),
		parent
	};
}
async function commitFiles(repository, hash, runner = run) {
	return (await commitFilesWithParent(repository, hash, runner)).files;
}
/** 是否有变基正在进行：`REBASE_HEAD` 只在 rebase 期间存在（一次 spawn，不读 .git 目录）。 */
async function rebaseInProgress(repository) {
	let gitDir = join(repository, ".git");
	try {
		if ((await lstat(gitDir)).isFile()) {
			const text = await readFile(gitDir, "utf8");
			const match = /^gitdir:\s*(.+)$/m.exec(text);
			if (match === null) return false;
			gitDir = resolve(repository, (match[1] ?? "").trim());
		}
	} catch {
		return false;
	}
	for (const name of ["rebase-merge", "rebase-apply"]) try {
		await access(join(gitDir, name));
		return true;
	} catch {}
	return false;
}
async function gitStatus(cwd, runner = run) {
	const repository = await gitRoot(cwd, runner);
	const result = await runner("git", [
		"status",
		"--porcelain=v2",
		"-z",
		"--branch",
		"--untracked-files=all"
	], repository);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr, 500);
	let branch = "HEAD";
	let ahead = 0;
	let behind = 0;
	const changes = [];
	for (const record of result.stdout.split("\0")) if (record.startsWith("# branch.head ")) branch = record.slice(14);
	else if (record.startsWith("# branch.ab ")) {
		const match = /\+(\d+) -(\d+)/.exec(record);
		ahead = Number(match?.[1] ?? 0);
		behind = Number(match?.[2] ?? 0);
	} else if (record.startsWith("? ")) changes.push({
		path: record.slice(2),
		index: "?",
		worktree: "?",
		staged: false,
		untracked: true
	});
	else if (record.startsWith("1 ") || record.startsWith("2 ")) {
		const parts = record.split(" ");
		const xy = parts[1] ?? "..";
		const path = parts.slice(record.startsWith("2 ") ? 9 : 8).join(" ");
		changes.push({
			path,
			index: xy[0] ?? ".",
			worktree: xy[1] ?? ".",
			staged: xy[0] !== ".",
			untracked: false
		});
	}
	return {
		repository,
		branch,
		ahead,
		behind,
		changes,
		rebase: await rebaseInProgress(repository)
	};
}
/**
* 引用名守卫（分支 / 标签共用）。
*
* git 自己的规则很碎（`check-ref-format`），这里只挡「明显非法 / 危险」的写法：
* 选项注入（以 `-` 开头）、空白、`..`、以及 git 明确禁止的字符，避免把用户输入当命令参数。
*/
const FORBIDDEN_REF_CHARS = [
	" ",
	"~",
	"^",
	":",
	"?",
	"*",
	"[",
	"\\"
];
function validateRefName(value, label) {
	const name = (value ?? "").trim();
	if (name === "" || name.startsWith("-") || name.includes("..") || name.endsWith("/") || name.endsWith(".")) throw new WorkbenchError("bad-request", `${label} name is invalid`);
	if (FORBIDDEN_REF_CHARS.some((char) => name.includes(char))) throw new WorkbenchError("bad-request", `${label} name is invalid`);
	return name;
}
function validateBranchName(value) {
	return validateRefName(value, "branch");
}
/** 标签名规则与分支一致：`check-ref-format` 对 refs/heads 与 refs/tags 是同一套。 */
function validateTagName(value) {
	return validateRefName(value, "tag");
}
/** 贮藏索引只接受纯数字：它会被拼进 `stash@{n}`，不能带任何其它字符。 */
function stashIndex(value) {
	if (!/^\d+$/.test(value ?? "")) throw new WorkbenchError("bad-request", "stash index is invalid");
	return value;
}
/** 提交图的取数：`-n` 条，可选 `--all`（显示全部分支）。 */
async function gitLog(runGit, count, all) {
	const args = [
		"log",
		"--topo-order",
		"--date=iso-strict",
		"--decorate=short",
		"--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x00",
		"-n",
		String(Math.min(1e3, Math.max(1, count)))
	];
	if (all) args.push("--all");
	const result = await runGit(args);
	if (result.code !== 0) {
		if ((await runGit([
			"rev-parse",
			"--verify",
			"HEAD"
		])).code !== 0) return [];
		throw new WorkbenchError("git-failed", result.stderr || result.stdout, 500);
	}
	return result.stdout.split("\0").filter(Boolean).map((record) => {
		const [rawHash = "", parents = "", author = "", date = "", subject = "", refs = ""] = record.split("");
		return {
			hash: rawHash.trim(),
			parents: parents.split(" ").filter(Boolean),
			author,
			date,
			subject,
			refs: refs.split(",").map((item) => item.trim()).filter(Boolean)
		};
	});
}
/** 本地 + 远程分支清单；空仓库（没有 HEAD）时 current 为空串。 */
async function gitBranchList(runGit) {
	const current = await runGit([
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	]);
	const local = await runGit([
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads"
	]);
	const remote = await runGit([
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/remotes"
	]);
	return {
		current: current.code === 0 ? current.stdout.trim() : "",
		local: local.code === 0 ? local.stdout.split("\n").map((value) => value.trim()).filter(Boolean) : [],
		remote: remote.code === 0 ? remote.stdout.split("\n").map((value) => value.trim()).filter((value) => value !== "" && !value.endsWith("/HEAD")) : []
	};
}
/** 远程名列表：`remotes` / `remote.add` / `remote.remove` 返回同一形状（字符串数组）。 */
async function gitRemoteNames(runGit) {
	const result = await runGit(["remote"]);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr, 500);
	return result.stdout.split("\n").map((item) => item.trim()).filter(Boolean);
}
/** 第一个远程名：push 类动作都约定推到第一个远程（与 VS Code 的提示语义一致）。 */
async function firstRemote(runGit) {
	const name = (await gitRemoteNames(runGit))[0];
	if (name === void 0) throw new WorkbenchError("git-failed", "没有配置远程仓库", 409);
	return name;
}
/** 推送参数：有上游就普通 push，没有上游就把当前分支推到第一个远程（与 VS Code 的提示语义一致）。 */
async function gitPushArgs(runGit) {
	if ((await runGit([
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}"
	])).code === 0) return ["push"];
	const name = await firstRemote(runGit);
	const branch = await runGit([
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	]);
	const branchName = branch.code === 0 ? branch.stdout.trim() : "";
	if (branchName === "" || branchName === "HEAD") throw new WorkbenchError("git-failed", "当前不在任何分支上，无法推送", 409);
	return [
		"push",
		"--set-upstream",
		name,
		branchName
	];
}
/**
* 把远程仓库克隆到工作区里的一个子目录。
*
* 不能先走 `gitRoot`：调用时工作区还不是 git 仓库（克隆成功后才变成仓库），所以这是唯一
* 在解析仓库根之前执行的动作。目标只接受工作区相对路径：绝对路径或 `..` 一律拒绝，
* 避免把仓库写到用户没有指定的位置；目录已存在等错误由 git 自己报，原样回传 stderr。
*/
async function cloneRepository(cwd, path, url, runner = run) {
	const target = path ?? "";
	if (target === "" || isAbsolute(target) || target.split(/[\\/]/).some((part) => part === "..")) throw new WorkbenchError("bad-request", "clone destination is invalid");
	if (url === void 0 || url === "") throw new WorkbenchError("bad-request", "clone url is required");
	const result = await runner("git", [
		"clone",
		"--",
		url,
		target
	], cwd);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
	return { cloned: true };
}
/** `git --name-status -z` 的解析：R/C 记录后面跟「旧路径 + 新路径」两个 token。 */
function parseNameStatus(stdout) {
	const tokens = stdout.split("\0").filter(Boolean);
	const files = [];
	for (let index = 0; index < tokens.length;) {
		const code = (tokens[index++] ?? "")[0] ?? "";
		if (code === "R" || code === "C") {
			const previousPath = tokens[index++] ?? "";
			const path = tokens[index++] ?? "";
			files.push({
				path,
				previousPath,
				status: code
			});
		} else {
			const path = tokens[index++] ?? "";
			files.push({
				path,
				status: code
			});
		}
	}
	return files;
}
/**
* `--numstat -z` 的解析。
*
* 为什么要和 name-status 的文件列表配对：-z 模式下 numstat 把路径拆成独立 token（重命名还会多一个旧路径），
* 单看 numstat 无法可靠区分「普通文件」与「重命名」；而 name-status 里已经知道哪些记录是 R/C，
* 按同一顺序消费 token 就是确定的。两个命令必须用同一套 `-M` 与提交区间，否则顺序可能不同。
*/
function parseNumstat(stdout, files) {
	const tokens = stdout.split("\0").filter((token) => token !== "");
	let cursor = 0;
	return files.map((file) => {
		const parts = (tokens[cursor++] ?? "").split("	");
		const adds = parts[0] ?? "0";
		const dels = parts[1] ?? "0";
		let path = parts.slice(2).join("	");
		let previousPath;
		if (path === "") {
			previousPath = tokens[cursor++] ?? void 0;
			path = tokens[cursor++] ?? "";
		}
		const binary = adds === "-" || dels === "-";
		return {
			status: file.status,
			path: path === "" ? file.path : path,
			...previousPath === void 0 ? {} : { previousPath },
			binary,
			additions: binary ? 0 : Number.parseInt(adds, 10) || 0,
			deletions: binary ? 0 : Number.parseInt(dels, 10) || 0
		};
	});
}
async function numstatFiles(runGit, args, files) {
	if (files.length === 0) return [];
	const result = await runGit(args);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
	return parseNumstat(result.stdout, files);
}
/** 一次提交的完整详情（提交详情面板）：元信息 + 完整正文 + 每个文件的增删行数。 */
async function commitDetail(repository, hash, runner) {
	const runGit = (gitArgs) => runner("git", gitArgs, repository);
	const meta = await runGit([
		"log",
		"-1",
		"--date=iso-strict",
		"--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
		hash
	]);
	if (meta.code !== 0) throw new WorkbenchError("git-failed", meta.stderr || meta.stdout, 409);
	const [fullHash = "", parents = "", author = "", email = "", date = "", subject = "", body = ""] = meta.stdout.split("");
	const { files, parent } = await commitFilesWithParent(repository, hash, runner);
	const stats = await numstatFiles(runGit, parent.code === 0 ? [
		"diff",
		"--numstat",
		"-z",
		"-M",
		parent.stdout.trim(),
		hash
	] : [
		"diff-tree",
		"--root",
		"--no-commit-id",
		"-r",
		"--numstat",
		"-z",
		"-M",
		hash
	], files);
	return {
		hash: fullHash.trim() || hash,
		parents: parents.split(" ").filter(Boolean),
		author,
		email,
		date,
		subject,
		body: body.trimEnd(),
		files: stats
	};
}
/** 两个提交之间的文件变更（提交对比视图）。 */
async function compareFiles(repository, from, to, runner) {
	const runGit = (gitArgs) => runner("git", gitArgs, repository);
	const nameStatus = await runGit([
		"diff",
		"--name-status",
		"-z",
		"-M",
		from,
		to
	]);
	if (nameStatus.code !== 0) throw new WorkbenchError("git-failed", nameStatus.stderr || nameStatus.stdout, 409);
	const files = parseNameStatus(nameStatus.stdout);
	return numstatFiles(runGit, [
		"diff",
		"--numstat",
		"-z",
		"-M",
		from,
		to
	], files);
}
/** `git remote -v` → 远程名与 URL（取 fetch 行；只有 push 行的裸远程才用 push 行兜底）。 */
async function gitRemoteList(runGit) {
	const result = await runGit(["remote", "-v"]);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr, 500);
	const remotes = [];
	const seen = /* @__PURE__ */ new Set();
	for (const kind of ["fetch", "push"]) {
		const pattern = new RegExp("^(\\S+)\\s+(\\S+)\\s+\\(" + kind + "\\)$");
		for (const line of result.stdout.split("\n")) {
			const match = pattern.exec(line.trim());
			if (match === null) continue;
			const name = match[1] ?? "";
			const url = match[2] ?? "";
			if (name === "" || seen.has(name)) continue;
			seen.add(name);
			remotes.push({
				name,
				url
			});
		}
	}
	return remotes;
}
/** 标签详情：附注标签能拿到打标签人、日期与说明；轻量标签只有 commit。 */
async function tagDetail(runGit, name) {
	const result = await runGit([
		"for-each-ref",
		"--format=%(refname:short)%1f%(objecttype)%1f%(objectname)%1f%(taggername)%1f%(taggeremail)%1f%(taggerdate:iso-strict)%1f%(contents:subject)%1f%(contents:body)",
		"refs/tags/" + name
	]);
	if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 500);
	const record = result.stdout.replace(/\r?\n$/, "");
	if (record === "") throw new WorkbenchError("not-found", "tag does not exist", 404);
	const [shortName = name, objectType = "commit", commit = "", tagger = "", email = "", date = "", subject = "", body = ""] = record.split("");
	const message = [subject, body].filter((part) => part !== "").join("\n\n");
	return {
		name: shortName.trim() || name,
		objectType: objectType.trim(),
		commit: commit.trim(),
		...tagger.trim() === "" ? {} : { tagger: tagger.trim() },
		...email.trim() === "" ? {} : { email: email.replace(/^<|>$/g, "").trim() },
		...date.trim() === "" ? {} : { date: date.trim() },
		message
	};
}
async function gitAction(cwd, action, path, value, runner = run) {
	if (action === "clone") return cloneRepository(cwd, path, value, runner);
	const repository = await gitRoot(cwd, runner);
	const runGit = (gitArgs) => runner("git", gitArgs, repository);
	let args;
	switch (action) {
		case "stage":
			args = [
				"add",
				"--",
				path ?? ""
			];
			break;
		case "stage.all":
			args = ["add", "-A"];
			break;
		case "unstage":
			args = [
				"restore",
				"--staged",
				"--",
				path ?? ""
			];
			break;
		case "unstage.all":
			args = [
				"restore",
				"--staged",
				"--",
				"."
			];
			break;
		case "discard":
			args = value === "untracked" ? [
				"clean",
				"-f",
				"--",
				path ?? ""
			] : [
				"restore",
				"--worktree",
				"--",
				path ?? ""
			];
			break;
		case "discard.all": {
			if ((await runGit([
				"rev-parse",
				"--verify",
				"HEAD"
			])).code === 0) {
				const restore = await runGit([
					"restore",
					"--source=HEAD",
					"--staged",
					"--worktree",
					"--",
					"."
				]);
				if (restore.code !== 0) throw new WorkbenchError("git-failed", restore.stderr || restore.stdout, 409);
			}
			const clean = await runGit(["clean", "-fd"]);
			if (clean.code !== 0) throw new WorkbenchError("git-failed", clean.stderr || clean.stdout, 409);
			return gitStatus(cwd, runner);
		}
		case "commit":
			args = [
				"commit",
				"-m",
				value ?? ""
			];
			break;
		case "commit.all": {
			const add = await runGit(["add", "-A"]);
			if (add.code !== 0) throw new WorkbenchError("git-failed", add.stderr || add.stdout, 409);
			const commit = await runGit([
				"commit",
				"-m",
				value ?? ""
			]);
			if (commit.code !== 0) throw new WorkbenchError("git-failed", commit.stderr || commit.stdout, 409);
			return gitStatus(cwd, runner);
		}
		case "commit.undo":
			args = [
				"reset",
				"--soft",
				"HEAD~1"
			];
			break;
		case "branch.create":
			args = [
				"switch",
				"-c",
				validateBranchName(value)
			];
			break;
		case "branch.switch": {
			const name = validateBranchName(value);
			const direct = await runGit(["switch", name]);
			if (direct.code !== 0) {
				const track = await runGit([
					"switch",
					"--track",
					"-c",
					name.includes("/") ? name.slice(name.indexOf("/") + 1) : name,
					name
				]);
				if (track.code !== 0) throw new WorkbenchError("git-failed", track.stderr || direct.stderr || direct.stdout, 409);
			}
			return gitStatus(cwd, runner);
		}
		case "branch.delete":
			args = [
				"branch",
				"-d",
				validateBranchName(value)
			];
			break;
		case "branch.rename":
			args = [
				"branch",
				"-m",
				validateBranchName(path),
				validateBranchName(value)
			];
			break;
		case "branch.list": return gitBranchList(runGit);
		case "merge": {
			const merged = await runGit([
				"merge",
				"--no-edit",
				validateBranchName(value)
			]);
			if (merged.code !== 0) throw new WorkbenchError("git-failed", merged.stderr || merged.stdout, 409);
			return gitStatus(cwd, runner);
		}
		case "merge.abort":
			args = ["merge", "--abort"];
			break;
		case "rebase":
			args = ["rebase", validateBranchName(value)];
			break;
		case "stash.push": {
			const message = value ?? "";
			args = path === "staged" ? [
				"stash",
				"push",
				"--staged"
			] : [
				"stash",
				"push",
				"--include-untracked"
			];
			if (message !== "") args.push("-m", message);
			break;
		}
		case "stash.list": {
			const listed = await runGit([
				"stash",
				"list",
				"--pretty=format:%gd%x1f%gs%x1f%cI%x00"
			]);
			if (listed.code !== 0) throw new WorkbenchError("git-failed", listed.stderr || listed.stdout, 500);
			const stashes = [];
			for (const record of listed.stdout.split("\0")) {
				const line = record.replace(/^\r?\n/, "");
				if (line === "") continue;
				const [ref = "", message = "", date = ""] = line.split("");
				const match = /stash@\{(\d+)\}/.exec(ref);
				if (match === null) continue;
				stashes.push({
					index: Number(match[1]),
					message,
					date
				});
			}
			return stashes;
		}
		case "stash.apply":
		case "stash.pop":
		case "stash.drop":
			args = [
				"stash",
				action.slice(6),
				`stash@{${stashIndex(value)}}`
			];
			break;
		case "tag.list": {
			const listed = await runGit([
				"for-each-ref",
				"--format=%(refname:short)%1f%(objectname:short)%1f%(subject)",
				"refs/tags"
			]);
			if (listed.code !== 0) throw new WorkbenchError("git-failed", listed.stderr || listed.stdout, 500);
			return listed.stdout.split("\n").filter(Boolean).map((record) => {
				const [name = "", hash = "", subject = ""] = record.split("");
				return {
					name,
					hash,
					subject
				};
			});
		}
		case "tag.create": {
			const raw = value ?? "";
			let name;
			let hash;
			let message;
			if (raw.trim().startsWith("{")) {
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					throw new WorkbenchError("bad-request", "tag payload must be valid JSON");
				}
				if (typeof parsed.name !== "string") throw new WorkbenchError("bad-request", "tag name is required");
				name = validateTagName(parsed.name);
				if (typeof parsed.hash === "string" && parsed.hash !== "") hash = validateCommitHash(parsed.hash);
				if (typeof parsed.message === "string" && parsed.message.trim() !== "") message = parsed.message;
			} else name = validateTagName(raw);
			const target = hash ?? (path === void 0 || path === "" ? void 0 : validateCommitHash(path));
			args = [
				"tag",
				...message === void 0 ? [] : ["-a"],
				name,
				...message === void 0 ? [] : ["-m", message],
				...target === void 0 ? [] : [target]
			];
			break;
		}
		case "tag.detail": return tagDetail(runGit, validateTagName(value));
		case "tag.delete":
			args = [
				"tag",
				"-d",
				validateTagName(value)
			];
			break;
		case "tag.push": {
			const name = (value ?? "") === "" ? void 0 : validateTagName(value);
			const remote = await firstRemote(runGit);
			args = name === void 0 ? [
				"push",
				remote,
				"--tags"
			] : [
				"push",
				remote,
				name
			];
			break;
		}
		case "remotes": return gitRemoteNames(runGit);
		case "remote.add": {
			if (path === void 0 || path === "" || value === void 0 || value === "") throw new WorkbenchError("bad-request", "remote name and url are required");
			const added = await runGit([
				"remote",
				"add",
				path,
				value
			]);
			if (added.code !== 0) throw new WorkbenchError("git-failed", added.stderr || added.stdout, 409);
			return gitRemoteNames(runGit);
		}
		case "remote.remove": {
			if (value === void 0 || value === "") throw new WorkbenchError("bad-request", "remote name is required");
			const removed = await runGit([
				"remote",
				"remove",
				value
			]);
			if (removed.code !== 0) throw new WorkbenchError("git-failed", removed.stderr || removed.stdout, 409);
			return gitRemoteNames(runGit);
		}
		case "remote.list": return gitRemoteList(runGit);
		case "remote.set": {
			const name = (path ?? "").trim();
			if (name === "" || /\s/.test(name)) throw new WorkbenchError("bad-request", "remote name is required");
			const url = (value ?? "").trim();
			if (url === "") throw new WorkbenchError("bad-request", "remote url is required");
			const result = (await gitRemoteNames(runGit)).includes(name) ? await runGit([
				"remote",
				"set-url",
				name,
				url
			]) : await runGit([
				"remote",
				"add",
				name,
				url
			]);
			if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
			return gitRemoteList(runGit);
		}
		case "remote.fetch": {
			const name = (path ?? "").trim();
			if (name.startsWith("-")) throw new WorkbenchError("bad-request", "remote name is invalid");
			args = name === "" ? [
				"fetch",
				"--all",
				"--prune"
			] : [
				"fetch",
				"--prune",
				name
			];
			break;
		}
		case "remote.prune": {
			const name = (path ?? "").trim();
			if (name === "" || name.startsWith("-")) throw new WorkbenchError("bad-request", "remote name is required");
			args = [
				"remote",
				"prune",
				name
			];
			break;
		}
		case "branches": {
			const result = await runGit([
				"for-each-ref",
				"--format=%(refname:short)",
				"refs/heads"
			]);
			if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr, 500);
			return result.stdout.split("\n").filter(Boolean);
		}
		case "log":
		case "log.all": return gitLog(runGit, Number.parseInt(value ?? "", 10) || 100, action === "log.all");
		case "commit.show": {
			const result = await runGit([
				"show",
				"--no-ext-diff",
				"--find-renames",
				"--format=fuller",
				"--stat",
				"--patch",
				"--no-color",
				validateCommitHash(value)
			]);
			if (result.code !== 0) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
			return {
				diff: result.stdout,
				original: "",
				modified: result.stdout
			};
		}
		case "commit.files": return commitFiles(repository, validateCommitHash(value), runner);
		case "commit.file.diff": {
			const hash = validateCommitHash(value);
			const target = validateGitPath(repository, path);
			const { files, parent } = await commitFilesWithParent(repository, hash, runner);
			const file = files.find((item) => item.path === target);
			if (file === void 0) throw new WorkbenchError("not-found", "file is not part of the commit", 404);
			const shown = parent.code === 0 ? await runGit([
				"diff",
				"--no-ext-diff",
				"--find-renames",
				"--patch",
				"--no-color",
				parent.stdout.trim(),
				hash,
				"--",
				file.previousPath ?? target,
				target
			]) : await runGit([
				"show",
				"--no-ext-diff",
				"--find-renames",
				"--format=",
				"--patch",
				"--no-color",
				hash,
				"--",
				file.previousPath ?? target,
				target
			]);
			if (shown.code !== 0) throw new WorkbenchError("git-failed", shown.stderr || shown.stdout, 409);
			const original = file.status === "A" || parent.code !== 0 ? "" : await gitObject(repository, `${parent.stdout.trim()}:${file.previousPath ?? target}`, runner);
			const modified = file.status === "D" ? "" : await gitObject(repository, `${hash}:${target}`, runner);
			return {
				diff: shown.stdout,
				original,
				modified
			};
		}
		case "commit.detail": return commitDetail(repository, validateCommitHash(value), runner);
		case "compare.files": return compareFiles(repository, validateCommitHash(path), validateCommitHash(value), runner);
		/**
		* 提交对比里打开单个文件的差异：path = 文件，value = `from..to` 两个哈希。
		* 与原版 Git Graph 的 Commit Comparison View 一样，diff 走编辑器里现成的差异标签。
		*/
		case "range.file.diff": {
			const target = validateGitPath(repository, path);
			const [rawFrom = "", rawTo = ""] = (value ?? "").split("..");
			const from = validateCommitHash(rawFrom);
			const to = validateCommitHash(rawTo);
			const shown = await runGit([
				"diff",
				"--no-ext-diff",
				"--find-renames",
				"--patch",
				"--no-color",
				from,
				to,
				"--",
				target
			]);
			if (shown.code !== 0) throw new WorkbenchError("git-failed", shown.stderr || shown.stdout, 409);
			const original = await gitObject(repository, `${from}:${target}`, runner);
			const modified = await gitObject(repository, `${to}:${target}`, runner);
			return {
				diff: shown.stdout,
				original,
				modified
			};
		}
		case "commit.exec": {
			let payload;
			try {
				payload = JSON.parse(value ?? "");
			} catch {
				throw new WorkbenchError("bad-request", "commit payload must be valid JSON");
			}
			const message = typeof payload.message === "string" && payload.message.trim() !== "" ? payload.message : void 0;
			const all = payload.all === true;
			const amend = payload.amend === true;
			const signed = payload.signed === true;
			const reuse = payload.reuse === true;
			if (message === void 0 && !amend && !reuse) throw new WorkbenchError("bad-request", "commit message is required");
			if (all) {
				const added = await runGit(["add", "-A"]);
				if (added.code !== 0) throw new WorkbenchError("git-failed", added.stderr || added.stdout, 409);
			}
			args = [
				"commit",
				...amend ? ["--amend"] : [],
				...message !== void 0 ? ["-m", message] : reuse ? ["-C", "HEAD"] : ["--no-edit"],
				...signed ? ["-S"] : []
			];
			break;
		}
		case "rebase.abort":
			args = ["rebase", "--abort"];
			break;
		case "commit.checkout":
			args = [
				"switch",
				"--detach",
				validateCommitHash(value)
			];
			break;
		case "commit.branch":
			args = [
				"switch",
				"-c",
				validateBranchName(path),
				validateCommitHash(value)
			];
			break;
		case "commit.cherrypick":
			args = ["cherry-pick", validateCommitHash(value)];
			break;
		case "commit.revert":
			args = [
				"revert",
				"--no-edit",
				validateCommitHash(value)
			];
			break;
		case "commit.reset": {
			const mode = path ?? "";
			if (mode !== "soft" && mode !== "mixed" && mode !== "hard") throw new WorkbenchError("bad-request", "reset mode must be soft, mixed or hard");
			args = [
				"reset",
				"--" + mode,
				validateCommitHash(value)
			];
			break;
		}
		case "commit.drop": {
			const hash = validateCommitHash(value);
			const parent = await runGit([
				"rev-parse",
				"--verify",
				hash + "^1"
			]);
			if (parent.code !== 0) throw new WorkbenchError("bad-request", "不能丢弃第一个提交");
			args = [
				"rebase",
				"--onto",
				parent.stdout.trim(),
				hash
			];
			break;
		}
		case "fetch":
			args = [
				"fetch",
				"--all",
				"--prune",
				"--quiet"
			];
			break;
		case "pull":
			args = ["pull"];
			break;
		case "push":
			args = await gitPushArgs(runGit);
			break;
		case "sync": {
			const pull = await runGit(["pull"]);
			if (pull.code !== 0) throw new WorkbenchError("git-failed", pull.stderr || pull.stdout, 409);
			const push = await runGit(await gitPushArgs(runGit));
			if (push.code !== 0) throw new WorkbenchError("git-failed", push.stderr || push.stdout, 409);
			return gitStatus(cwd, runner);
		}
		case "diff":
			args = value === "untracked" ? [
				"diff",
				"--no-index",
				"--",
				process.platform === "win32" ? "NUL" : "/dev/null",
				path ?? ""
			] : [
				"diff",
				...value === "staged" ? ["--cached"] : [],
				"--",
				path ?? ""
			];
			break;
		default: throw new WorkbenchError("bad-action", `unknown Git action ${action}`);
	}
	if (args.some((arg) => arg === "") && action !== "commit") throw new WorkbenchError("bad-request", "path or value is required");
	const result = await runGit(args);
	const expectedUntrackedDifference = action === "diff" && value === "untracked" && result.code === 1;
	if (result.code !== 0 && !expectedUntrackedDifference) throw new WorkbenchError("git-failed", result.stderr || result.stdout, 409);
	if (action !== "diff") return gitStatus(cwd, runner);
	const target = validateGitPath(repository, path);
	const original = value === "untracked" ? "" : await gitObject(repository, `${value === "staged" ? "HEAD:" : ":"}${target}`, runner);
	const modified = value === "staged" ? await gitObject(repository, `:${target}`, runner) : await readFile(resolve(repository, target), "utf8").catch(() => "");
	return {
		diff: result.stdout,
		original,
		modified
	};
}
//#endregion
//#region src/terminal.ts
const SENSITIVE = /(api[_-]?key|token|credential|secret|password|passwd|private[_-]?key|^dsh_.*(?:key|token|secret))/i;
const MAX_TERMINALS = 8;
/** 回放缓冲里最多留这么多字节。 */
const REPLAY_STORE_BYTES = 524288;
/** 一次送出的字符数。整段一次性送出会让客户端在一次解析里卡住。 */
const REPLAY_CHUNK_CHARS = 65536;
/**
* 回放缓冲。
*
* 原先是单个字符串：每拿到一块数据就对整段做一次 `Buffer.byteLength`，超限时再整段
* `slice`。输出越久，单块越贵，整体是 O(n²)。改成按块保存、增量记账后，单块成本是 O(块长)。
*
* 保留量按「能显示的部分」定：xterm 的 scrollback 默认 1000 行，超出的字节不会被显示，
* 却要在每次重连时序列化、传输、解析。实测保留 2 MiB 时，切一次标签要送 2,331,945 字节，
* 主线程被卡 372ms、约 715ms 才恢复。
*/
var ReplayBuffer = class {
	chunks = [];
	bytes = 0;
	push(data) {
		this.chunks.push(data);
		this.bytes += Buffer.byteLength(data);
		while (this.bytes > REPLAY_STORE_BYTES && this.chunks.length > 1) this.bytes -= Buffer.byteLength(this.chunks.shift());
		if (this.bytes > REPLAY_STORE_BYTES) {
			const tail = (this.chunks[0] ?? "").slice(-524288);
			this.chunks[0] = tail;
			this.bytes = Buffer.byteLength(tail);
		}
	}
	/** 重连时该看到的那一段：末尾若干行，并从行边界起算，避免半行或半截转义序列。 */
	tail() {
		const raw = this.chunks.join("");
		if (raw === "") return "";
		const lines = raw.split("\n");
		const keep = lines.length > 1e3 ? lines.slice(-1e3).join("\n") : raw;
		if (Buffer.byteLength(keep) <= 262144) return keep;
		const cut = keep.slice(-262144);
		const boundary = cut.indexOf("\n");
		return boundary === -1 ? cut : cut.slice(boundary + 1);
	}
};
/** 按字符切块；不切开代理对。 */
function replayChunks(text) {
	if (text.length <= 65536) return [text];
	const chunks = [];
	let index = 0;
	while (index < text.length) {
		let end = Math.min(index + REPLAY_CHUNK_CHARS, text.length);
		if (end < text.length) {
			const last = text.charCodeAt(end - 1);
			if (last >= 55296 && last <= 56319) end -= 1;
		}
		chunks.push(text.slice(index, end));
		index = end;
	}
	return chunks;
}
const defaultClock = {
	schedule(run, ms) {
		const timer = setTimeout(run, ms);
		const handle = timer;
		if (typeof handle.unref === "function") handle.unref();
		return timer;
	},
	cancel(handle) {
		clearTimeout(handle);
	}
};
/**
* 终端输出的**按连接合批器**。
*
* 为什么需要：pty 的数据块很小（Windows conpty 常见 4–16KB），原先每块都 `JSON.stringify` 一次再
* `send` 一帧。ANSI 转义让 JSON 膨胀 44–46%（ESC → `\u001b`），实测 stringify 4KB=8.2µs、64KB=195µs，
* 客户端 parse 4KB=5.8µs、64KB=73.6µs。大输出（`pnpm build` 级 5MB/s）就是每秒上千次序列化、
* 上千个 ws 帧、上千次客户端 parse 与 xterm.write 调用 ── 其中**每帧的固定开销**才是合批能拿掉的部分。
*
* 语义保证（这几条是正确性的底线，都有单测）：
* - **顺序不变**：只做字符串拼接，不同块之间的相对顺序与原样发送时一致；
* - **逐字节不变**：不解析、不重编码 ANSI 内容；
* - **不丢尾部**：`push(..., true)` 表示「这一块之后必须立刻可见」（进程退出消息），会把包含它在内的
*   整个缓冲立刻发出去；连接关闭时 `dispose()` 尽力把剩余内容发出；
* - **定时器不残留**：flush/dispose 都会 cancel，宿主侧默认定时器还 `unref()`。
*
* sequence 取「本次合批里最后一块的 sequence」：客户端只用它转给 xterm（不校验连续性），
* 合批后这个值就是「这一帧的末尾状态」，与逐块发送时最后一块一致。
*/
var OutputCoalescer = class {
	send;
	buffer = "";
	lastSequence = 0;
	timer;
	disposed = false;
	flushAfterMs;
	flushAtChars;
	clock;
	constructor(send, options = {}) {
		this.send = send;
		this.flushAfterMs = options.flushAfterMs ?? 8;
		this.flushAtChars = options.flushAtChars ?? 32768;
		this.clock = options.clock ?? defaultClock;
	}
	/** 追加一块输出。immediate 表示「到这块为止必须立刻发出」（进程退出消息）。 */
	push(sequence, data, immediate = false) {
		if (this.disposed) return;
		if (data !== "") this.buffer += data;
		this.lastSequence = sequence;
		if (immediate || this.buffer.length >= this.flushAtChars) {
			this.flush();
			return;
		}
		if (this.buffer !== "" && this.timer === void 0) this.timer = this.clock.schedule(() => {
			this.timer = void 0;
			this.flush();
		}, this.flushAfterMs);
	}
	/** 把缓冲里的内容作为一帧发出；空缓冲是空操作。 */
	flush() {
		this.cancelTimer();
		if (this.buffer === "") return;
		const data = this.buffer;
		this.buffer = "";
		this.send({
			type: "output",
			sequence: this.lastSequence,
			data
		});
	}
	/** 连接关闭：把剩余内容交出去一次，然后彻底停掉（定时器不残留、之后的 push 忽略）。 */
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelTimer();
		if (this.buffer === "") return;
		const data = this.buffer;
		this.buffer = "";
		this.send({
			type: "output",
			sequence: this.lastSequence,
			data
		});
	}
	/** 仅供测试与排查：尚未发出的字符数与是否有 pending 定时器。 */
	get state() {
		return {
			chars: this.buffer.length,
			scheduled: this.timer !== void 0
		};
	}
	cancelTimer() {
		if (this.timer === void 0) return;
		this.clock.cancel(this.timer);
		this.timer = void 0;
	}
};
/** Remove credentials while retaining ordinary interactive-shell variables. */
function sanitizedTerminalEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== void 0 && !SENSITIVE.test(key)));
}
/**
* 平台默认的交互式 shell —— 也是「默认终端」在本机没有 PowerShell 7 时的落点。
*
* Windows 上用 COMSPEC —— 也就是用户自己的命令解释器 —— 原样启动，不替换成别的、也不加
* 抑制启动横幅的参数。原先的写法是「COMSPEC 指向 powershell 就用它，否则一律 powershell.exe
* 加 -NoLogo」：当用户的 COMSPEC 是 cmd.exe 时，它会被悄悄换成 PowerShell，于是终端里看到的
* 是 PS 提示符，用户熟悉的 cmd 横幅（Microsoft Windows [版本 …]）永远不会出现。终端应当呈现
* 用户自己的环境。
*/
function defaultTerminalShell(platform = process.platform, env = process.env) {
	if (platform === "win32") {
		const comspec = env.COMSPEC?.trim();
		return {
			shell: comspec !== void 0 && comspec !== "" ? comspec : "powershell.exe",
			args: []
		};
	}
	return {
		shell: env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
		args: ["-l"]
	};
}
/** probe 的真实实现：读 PATH、查文件系统。 */
function systemProbe(env = process.env) {
	const path = env.PATH ?? "";
	return {
		exists: (candidate) => existsSync(candidate),
		which: (file) => {
			for (const directory of path.split(delimiter)) {
				if (directory === "") continue;
				const candidate = join(directory, file);
				if (existsSync(candidate)) return candidate;
			}
		}
	};
}
/**
* 探测本机可用的交互式 shell。
*
* 只认这几个已知名字，**不接受客户端传来的任意路径**：客户端给的是 profile id，
* 由宿主在自己的探测结果里查，查不到就报错。否则这个接口就成了「按调用者的意思启动任意程序」。
*
* Git Bash 的定位方式：从 `git.exe` 回推安装目录（PATH 上的 git 通常位于 `<root>\cmd\git.exe`，
* 与 `<root>\bin\bash.exe` 同级），比硬编码 `C:\Program Files\Git` 稳 —— 便携安装不在那里。
*/
function resolvedTerminalProfiles(platform, env, probe) {
	if (platform !== "win32") {
		const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
		return [{
			id: "default",
			label: basename(shell),
			shell,
			args: ["-l"]
		}];
	}
	const profiles = [];
	const windows = win32;
	const pwsh = probe.which("pwsh.exe");
	if (pwsh !== void 0) profiles.push({
		id: "pwsh",
		label: "PowerShell",
		shell: pwsh,
		args: []
	});
	const powershell = probe.which("powershell.exe");
	if (powershell !== void 0) profiles.push({
		id: "windows-powershell",
		label: "Windows PowerShell",
		shell: powershell,
		args: []
	});
	const git = probe.which("git.exe");
	if (git !== void 0) {
		const root = windows.dirname(windows.dirname(git));
		const bash = [windows.join(root, "bin", "bash.exe"), windows.join(root, "usr", "bin", "bash.exe")].find((candidate) => probe.exists(candidate));
		if (bash !== void 0) profiles.push({
			id: "git-bash",
			label: "Git Bash",
			shell: bash,
			args: ["--login", "-i"]
		});
	}
	const comspec = env.COMSPEC?.trim();
	if (comspec !== void 0 && comspec !== "") profiles.push({
		id: "cmd",
		label: "Command Prompt",
		shell: comspec,
		args: []
	});
	const systemRoot = env.SystemRoot?.trim() || env.windir?.trim();
	if (systemRoot !== void 0 && systemRoot !== "") {
		const wsl = windows.join(systemRoot, "System32", "bash.exe");
		if (probe.exists(wsl)) profiles.push({
			id: "wsl",
			label: "WSL",
			shell: wsl,
			args: []
		});
	}
	return profiles;
}
/** 供客户端渲染「新建终端」菜单的列表。 */
function terminalProfiles(platform = process.platform, env = process.env, probe = systemProbe(env)) {
	return resolvedTerminalProfiles(platform, env, probe).map(({ id, label }) => ({
		id,
		label
	}));
}
/**
* 按 profile id 解析出要启动的 shell。
*
* id 缺失时是「默认终端」：本机装了 PowerShell 7 就用 pwsh，否则仍是用户自己的命令解释器
* （Windows 上 COMSPEC 原样启动，类 Unix 上是 SHELL）。菜单里的「新建终端」与命令入口走的都是
* 这条缺省路径。
*/
function terminalShell(profileId, platform = process.platform, env = process.env, probe = systemProbe(env)) {
	const profiles = resolvedTerminalProfiles(platform, env, probe);
	if (profileId === void 0 || profileId === "") {
		const preferred = profiles.find((candidate) => candidate.id === "pwsh");
		return preferred === void 0 ? defaultTerminalShell(platform, env) : {
			shell: preferred.shell,
			args: preferred.args
		};
	}
	const profile = profiles.find((candidate) => candidate.id === profileId);
	if (profile === void 0) throw new Error(`unknown terminal profile: ${profileId}`);
	return {
		shell: profile.shell,
		args: profile.args
	};
}
/** 默认标题：可执行名去掉扩展名 —— cmd.exe → cmd、pwsh.exe → pwsh、/bin/bash → bash。 */
function terminalTitleBase(shell) {
	const name = shell.split(/[\\/]/).filter((part) => part !== "").pop() ?? shell;
	return name.replace(/\.(exe|com|cmd|bat)$/i, "") || name;
}
/**
* 同名终端补序号：cmd、cmd (1)、cmd (2)。
*
* 原先默认标题取的是可执行文件名，于是同一个 shell 开几个都叫 `cmd.exe` —— 标签栏和右侧
* 列表完全分不出谁是谁。这里按「当前有没有被占用」挑最小序号；手动改过的名字只是占用一个位置，
* 不影响后来新建的基础名。
*/
function uniqueTerminalTitle(base, taken) {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let index = 1; index < 1e4; index++) {
		const candidate = `${base} (${index})`;
		if (!used.has(candidate)) return candidate;
	}
	return `${base} (${used.size})`;
}
/** 终端面向用户的错误码/中文消息；与重构前逐字一致（tests/terminal-directory.spec.ts 依赖）。 */
const TERMINAL_PATH_ERRORS = {
	outside: (raw) => new WorkbenchError("directory-outside", `终端目录超出了工作区：${raw}`, 400),
	symlinkOutside: (raw) => new WorkbenchError("directory-outside", `终端目录通过符号链接指向了工作区之外：${raw}`, 400),
	missing: (raw) => new WorkbenchError("directory-not-found", `终端目录不存在：${raw}`, 400),
	notDirectory: (raw) => new WorkbenchError("directory-invalid", `终端目录不是文件夹：${raw}`, 400)
};
/**
* 解析「在终端中打开」给出的目录。
*
* 客户端传的是工作区**相对**路径（`''`/缺省表示工作区根）。终端会在这个目录里启动一个真正的
* shell，所以边界必须和文件 API 一样严：不接收绝对路径、解析后必须落在工作区内、不能借符号链接
* 跳出去、且必须是一个已存在的目录。任何一条不满足都抛 400 —— 这是调用方给了不能用的目录，
* 不是宿主内部错误；消息直接显示在终端面板里，所以要能看懂。
*
* 为什么在宿主侧再解析一次而不是信任客户端：相对路径可能带 `..`，而且符号链接只有宿主看得见；
* 只靠客户端校验等于把「能起 shell 的目录」交给页面决定。
*/
function resolveTerminalDirectory(cwd, directory) {
	const root = realpathSync(cwd);
	if (directory === void 0 || directory === "") return root;
	if (isAbsolute(directory)) throw new WorkbenchError("directory-invalid", "终端目录必须是工作区内的相对路径", 400);
	return resolveExistingWorkspacePathSync(root, directory, TERMINAL_PATH_ERRORS, { kind: "directory" }).actual;
}
const defaultSpawn = (shell, args, options) => pty.spawn(shell, args, options);
/** 预热 shell 最多留多久：没人来认领就杀掉，别让后台多出一个长期 shell。 */
const PREWARM_TTL_MS = 9e4;
/**
* 是否启用终端预热。
*
* 预热是「多一个后台 shell 换启动速度」的取舍；默认开启，但留给不想多进程的部署一个开关：
* `DWV_TERMINAL_PREWARM=0`（或 false/off）关掉。未知值一律视为开启。
*/
function terminalPrewarmEnabled(env = process.env) {
	const value = env.DWV_TERMINAL_PREWARM?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}
/**
* 按工作区持有交互式终端，并额外维护**一个**预热 shell。
*
* 为什么要预热：实测 pwsh 从 spawn 到提示符可用平均约 530ms（大头是 profile 加载，不是我们的
* 代码）。用户点「新建终端」到看见提示符的这段时间没法再压缩，但可以提前到「面板已经打开、
* 用户还在看」的空档里 —— 面板一打开先把默认 shell 起好，点下去时回放缓冲里已经有提示符了。
*
* 认领规则：只有工作区根目录、且解析出的 shell 与预热时一致的新建请求才会拿走它；其余请求
* （「在终端中打开」的子目录、选了别的 shell）照常现起，预热 shell 留着给下一次默认新建。
* 90 秒没人用就自己退出（见 PREWARM_TTL_MS）。
*/
var TerminalManager = class {
	spawn;
	warmTtlMs;
	prewarmEnabled;
	workspaces = /* @__PURE__ */ new Map();
	warm;
	constructor(spawn = defaultSpawn, warmTtlMs = PREWARM_TTL_MS, prewarmEnabled = () => terminalPrewarmEnabled()) {
		this.spawn = spawn;
		this.warmTtlMs = warmTtlMs;
		this.prewarmEnabled = prewarmEnabled;
	}
	workspace(cwd) {
		return realpathSync(cwd);
	}
	list(cwd) {
		return [...this.workspaces.get(this.workspace(cwd))?.values() ?? []].map((handle) => ({ ...handle.info }));
	}
	/**
	* 起一个预热 shell。
	*
	* 同一个工作区只保留一个；换到别的工作区时把旧的丢掉（它已经没机会被认领了）。
	* 已有终端时也允许预热：用户可能还要再开一个，而列表状态由客户端判断。
	*/
	prewarm(cwd) {
		if (!this.prewarmEnabled()) return;
		const key = this.workspace(cwd);
		if (this.warm !== void 0 && this.warm.key === key) return;
		this.dropWarm();
		const { shell, args } = terminalShell();
		const handle = this.spawnHandle(key, shell, args);
		const timer = setTimeout(() => {
			if (this.warm?.handle === handle) this.dropWarm();
		}, this.warmTtlMs);
		if (typeof timer.unref === "function") timer.unref?.();
		this.warm = {
			key,
			target: key,
			shell,
			handle,
			timer
		};
	}
	/**
	* 新建终端。`directory` 是工作区相对目录（「在终端中打开」），缺省为工作区根。
	*
	* pty 的 cwd 用解析后的绝对目录，`TerminalInfo.cwd` 记的也是它 —— 客户端据此显示
	* 「这个终端实际在哪」，重连/排查时不必再猜一次。
	*/
	create(cwd, title, profileId, directory) {
		const key = this.workspace(cwd);
		const target = resolveTerminalDirectory(key, directory);
		const terminals = this.workspaces.get(key) ?? /* @__PURE__ */ new Map();
		this.workspaces.set(key, terminals);
		if (terminals.size >= MAX_TERMINALS) throw new Error(`terminal limit reached (${MAX_TERMINALS})`);
		const { shell, args } = terminalShell(profileId);
		const handle = this.takeWarm(key, target, shell) ?? this.spawnHandle(target, shell, args);
		const info = handle.info;
		info.id = randomUUID();
		info.cwd = target;
		info.title = title || uniqueTerminalTitle(terminalTitleBase(shell), [...terminals.values()].map((value) => value.info.title));
		terminals.set(info.id, handle);
		return { ...info };
	}
	/** 真正起一个 shell 并接上输出采集；创建路径与预热路径共用这一份。 */
	spawnHandle(target, shell, args) {
		const child = this.spawn(shell, args, {
			name: "xterm-256color",
			cols: 80,
			rows: 24,
			cwd: target,
			env: sanitizedTerminalEnv(process.env)
		});
		const info = {
			id: "",
			title: "",
			cwd: target,
			running: true,
			sequence: 0
		};
		const handle = {
			info,
			process: child,
			replay: new ReplayBuffer(),
			listeners: /* @__PURE__ */ new Set()
		};
		child.onData((data) => {
			info.sequence++;
			handle.replay.push(data);
			for (const listener of handle.listeners) listener({
				sequence: info.sequence,
				data
			});
		});
		child.onExit(({ exitCode }) => {
			info.running = false;
			info.exitCode = exitCode;
			info.sequence++;
			const data = `\r\n[process exited with code ${exitCode}]\r\n`;
			for (const listener of handle.listeners) listener({
				sequence: info.sequence,
				data,
				immediate: true
			});
		});
		return handle;
	}
	/** 认领预热 shell：目录与 shell 都对上、而且它还活着才提上来；不匹配就留着。 */
	takeWarm(key, target, shell) {
		const warm = this.warm;
		if (warm === void 0) return void 0;
		if (warm.key !== key || warm.target !== target || warm.shell !== shell) return void 0;
		clearTimeout(warm.timer);
		this.warm = void 0;
		if (warm.handle.info.running) return warm.handle;
		try {
			warm.handle.process.kill();
		} catch {}
	}
	dropWarm() {
		const warm = this.warm;
		if (warm === void 0) return;
		this.warm = void 0;
		clearTimeout(warm.timer);
		try {
			warm.handle.process.kill();
		} catch {}
	}
	get(cwd, id) {
		return this.workspaces.get(this.workspace(cwd))?.get(id);
	}
	close(cwd, id) {
		const key = this.workspace(cwd);
		const terminals = this.workspaces.get(key);
		const handle = terminals?.get(id);
		if (handle === void 0 || terminals === void 0) return;
		terminals.delete(id);
		try {
			handle.process.kill();
		} catch {}
		if (terminals.size === 0) this.workspaces.delete(key);
	}
	rename(cwd, id, title) {
		const handle = this.get(cwd, id);
		if (handle === void 0) throw new Error("terminal not found");
		handle.info.title = title;
		return { ...handle.info };
	}
	dispose() {
		this.dropWarm();
		for (const [cwd, terminals] of this.workspaces) for (const id of terminals.keys()) this.close(cwd, id);
	}
};
function terminalRequestAllowed(req) {
	const host = req.headers.host;
	if (host === void 0 || req.headers["sec-fetch-site"] === "cross-site") return false;
	let hostname;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	if (hostname !== "localhost" && hostname !== "[::1]" && !hostname.startsWith("127.")) return false;
	const origin = req.headers.origin;
	try {
		return origin === void 0 || new URL(origin).host === host;
	} catch {
		return false;
	}
}
/**
* 本机地址，供客户端拼 WebSocket 用。
*
* 为什么需要它：桌面端(Electron)的页面跑在 `dsh-app://app/` 下，`location.host` 是 `app`，
* 客户端按它拼出来的 `ws://app/…` 根本无法连接（实测 close code 1006）。桌面端把 HTTP 请求
* 经自定义协议转发给宿主，但 **WebSocket 的 upgrade 不经过那条转发**，所以必须给客户端一个
* 宿主的绝对地址。
*
* **只用 `req.socket.localPort`** —— 它回答的是「这个请求打到了哪个端口」，是第一手事实。
*
* 明确不用 `DSH_WEB_URL`：它由 DSH 的 web-app 注册在 shellEnv 上，描述的是 **shell 命令所在
* 那个 Harness 实例**的地址，未必是当前宿主。实测代价很直观 —— 在桌面端内启动的 Web 测试实例
* 会继承 `DSH_WEB_URL=http://127.0.0.1:19387`，于是 Web 端的终端跑去连桌面端的端口，连接失败
* （close 1006）、终端空白。两个来源在这种情况下会给出互相矛盾的答案，而 localPort 是对的。
*
* 只输出回环地址：客户端就在本机，没有理由把对外地址交出去。
*/
function localBase(req) {
	const port = req.socket.localPort;
	if (typeof port !== "number" || port <= 0) return void 0;
	return `http://${req.socket.localAddress === "::1" ? "[::1]" : "127.0.0.1"}:${port}`;
}
/** Register the private local terminal API and WebSocket transport. */
function installTerminal(ctx) {
	const manager = new TerminalManager();
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-vscode-terminal/api",
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			if (!terminalRequestAllowed(req)) return send(res, 403, {
				ok: false,
				error: { message: "forbidden" }
			});
			if (req.method !== "POST") return send(res, 405, {
				ok: false,
				error: { message: "POST required" }
			});
			try {
				const body = await readBody(req);
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
				if (sessionId === "") throw new Error("sessionId required");
				const cwd = cwdFor(ctx, sessionId);
				const method = new URL(req.url ?? "/", "http://dsh.local").pathname.slice(25);
				let value;
				if (method === "list") value = manager.list(cwd);
				else if (method === "profiles") value = terminalProfiles();
				else if (method === "create") value = manager.create(cwd, typeof body.title === "string" ? body.title : void 0, typeof body.profile === "string" ? body.profile : void 0, typeof body.directory === "string" ? body.directory : void 0);
				else if (method === "close") {
					manager.close(cwd, typeof body.id === "string" ? body.id : "");
					value = manager.list(cwd);
				} else if (method === "rename") value = manager.rename(cwd, typeof body.id === "string" ? body.id : "", typeof body.title === "string" ? body.title : "");
				else if (method === "prewarm") {
					manager.prewarm(cwd);
					value = manager.list(cwd);
				} else throw new Error("unknown terminal method");
				send(res, 200, {
					ok: true,
					value,
					wsBase: localBase(req)
				});
			} catch (error) {
				sendError(res, error);
			}
		}
	}), "dsh-aide: terminal API");
	const webSocket = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/dsh-vscode-terminal/ws",
		handler(req, socket, head) {
			if (ctx.connection.requestRejection(req) !== void 0 || !terminalRequestAllowed(req)) {
				socket.destroy();
				return;
			}
			webSocket.handleUpgrade(req, socket, head, (connection) => {
				const url = new URL(req.url ?? "/", "http://dsh.local");
				const sessionId = url.searchParams.get("sessionId");
				const id = url.searchParams.get("id");
				if (sessionId === null || id === null) {
					connection.close(1008, "sessionId and id required");
					return;
				}
				let handle;
				try {
					handle = manager.get(cwdFor(ctx, sessionId), id);
				} catch {
					connection.close(1008, "session workspace unavailable");
					return;
				}
				if (handle === void 0) {
					connection.close(1008, "terminal not found");
					return;
				}
				const replay = handle.replay.tail();
				if (replay !== "") {
					const sequence = handle.info.sequence;
					for (const chunk of replayChunks(replay)) connection.send(JSON.stringify({
						type: "replay",
						sequence,
						data: chunk
					}));
				}
				const coalescer = new OutputCoalescer((frame) => {
					if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(frame));
				});
				const listener = (output) => coalescer.push(output.sequence, output.data, output.immediate === true);
				handle.listeners.add(listener);
				connection.on("message", (raw) => {
					const text = raw.toString();
					try {
						const message = JSON.parse(text);
						if (message !== null && typeof message === "object" && "type" in message && message.type === "input" && "data" in message && typeof message.data === "string") handle.process.write(message.data);
						else if (message !== null && typeof message === "object" && "type" in message && message.type === "resize" && "cols" in message && "rows" in message && typeof message.cols === "number" && typeof message.rows === "number") handle.process.resize(Math.max(2, Math.floor(message.cols)), Math.max(2, Math.floor(message.rows)));
					} catch {
						handle.process.write(text);
					}
				});
				connection.on("close", () => {
					coalescer.dispose();
					handle.listeners.delete(listener);
				});
			});
		}
	}), "dsh-aide: terminal WebSocket");
	ctx.effect(() => () => {
		webSocket.close();
		manager.dispose();
	}, "dsh-aide: terminal teardown");
}
//#endregion
//#region src/completion/fallback.ts
/**
* 主提供方失败时改用备用提供方。
*
* 只在主提供方**抛错**时回落；已经产出的增量会被保留（不重放），因为重放会让客户端收到两遍内容。
*/
function fallbackProvider(primary, secondary, options = {}) {
	return {
		id: `${primary.id}+${secondary.id}`,
		get model() {
			return primary.model;
		},
		async *complete(prompt, context) {
			let emitted = false;
			try {
				for await (const chunk of primary.complete(prompt, context)) {
					if (chunk.done === false && chunk.text !== "") emitted = true;
					yield chunk;
				}
				return;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				options.onFallback?.({
					provider: primary.id,
					model: primary.model,
					error: reason
				});
				if (emitted) throw error;
			}
			if (context.signal.aborted) return;
			yield* secondary.complete(prompt, context);
		}
	};
}
//#endregion
//#region src/completion/settings.ts
const DEFAULT_COMPLETION_SETTINGS = { fallback: false };
let current$1 = DEFAULT_COMPLETION_SETTINGS;
/** 重读设置文件的间隔：够短，改完几乎立刻生效；够长，不至于每次补全都读盘。 */
const FILE_RECHECK_MS$1 = 2e3;
let fileCheckedAt$1 = 0;
let fileValue$1;
/** 解析「provider/model」；空值、缺斜杠、任一侧为空串都视为没配。 */
function parseRoute(raw) {
	if (raw === void 0 || raw === "") return void 0;
	const at = raw.indexOf("/");
	if (at <= 0 || at === raw.length - 1) return void 0;
	return {
		provider: raw.slice(0, at),
		model: raw.slice(at + 1)
	};
}
/** 环境变量给出的覆盖；没有则返回空对象。 */
function fromEnvironment(env) {
	const override = {};
	const route = parseRoute(env["DSH_COMPLETION_ROUTE"]);
	if (route !== void 0) override.route = route;
	if ((env["DSH_COMPLETION_FALLBACK"] ?? "").toLowerCase() === "local") override.fallback = true;
	return override;
}
/** 插件配置给出的设置；字段缺失或不合法就当作没设。 */
function fromConfig(config) {
	if (typeof config !== "object" || config === null) return {};
	const record = config;
	const completion = typeof record["completion"] === "object" && record["completion"] !== null ? record["completion"] : record;
	const settings = {};
	const route = parseRoute(typeof completion["route"] === "string" ? completion["route"] : void 0);
	if (route !== void 0) settings.route = route;
	if (completion["fallback"] === true) settings.fallback = true;
	if (completion["fallback"] === false) settings.fallback = false;
	return settings;
}
/** 生效的设置：默认值 + 插件配置 + 设置文件 + 环境变量。 */
function resolveSettings(config, env = globalThis.process?.env ?? {}, file) {
	return {
		...DEFAULT_COMPLETION_SETTINGS,
		...fromConfig(config),
		...fromConfig(file),
		...fromEnvironment(env)
	};
}
/**
* 从数据目录读设置文件。
*
* 为什么需要它：当前 DSH 版本里，bundle patch 的 `config` 送不到插件的 `apply`（同类插件的配置同样
* 送不到，实测过）。而桌面端应用不方便设环境变量，所以留一个用户可编辑、又不动配置档的入口：
* `%DSH_HOME%/completion.settings.json`，形如 `{ "completion": { "route": "provider/model", "fallback": true } }`。
* 文件不存在、不是 JSON、字段不合法，一律当作没设 —— 绝不因为一个写错的文件让补全整体失效。
*/
function readSettingsFile(path, readFile = defaultReadFile) {
	try {
		return JSON.parse(readFile(path));
	} catch {
		return;
	}
}
function nodeFs() {
	const load = globalThis.process?.getBuiltinModule;
	return load?.("node:fs");
}
function defaultReadFile(path) {
	const fs = nodeFs();
	if (fs?.readFileSync === void 0) throw new Error("readFileSync unavailable");
	return fs.readFileSync(path, "utf8");
}
/** 设置文件的位置：数据目录下固定名字。数据目录未知时返回 undefined。 */
/**
* 补全诊断日志的路径：与设置文件同级（%DSH_HOME% 下），便于在应用侧排查「没有补全」类问题。
*
* 记录请求是否到达、用的是模型还是本地兜底、以及失败原因 —— 这三件事决定了问题出在客户端、
* 选路还是模型调用。日志只用于排查，不参与任何决策。
*/
function diagnosticLogPath(env = globalThis.process?.env ?? {}) {
	return settingsFilePath(env)?.replace(/completion\.settings\.json$/, "completion.log");
}
function settingsFilePath(env = globalThis.process?.env ?? {}) {
	const home = env["DSH_HOME"];
	if (home === void 0 || home === "") return void 0;
	return `${home.replace(/[\\/]+$/, "").replaceAll("\\", "/")}/completion.settings.json`;
}
let pluginConfig$1;
/** 插件加载时写入一次；同时在每次取用时按周期重读设置文件。 */
function setCompletionSettings(config) {
	pluginConfig$1 = config;
	return refreshSettings();
}
/**
* 取当前生效的设置。
*
* 设置文件按 `FILE_RECHECK_MS` 的周期重读：用户在编辑器旁边改完 JSON，几秒内生效，不必重启应用。
* 读盘失败或内容不合法都退回「当作没设」，不影响已有设置。
*/
function completionSettings(now = Date.now()) {
	if (now - fileCheckedAt$1 >= FILE_RECHECK_MS$1) refreshSettings(now);
	return current$1;
}
function refreshSettings(now = Date.now()) {
	const env = globalThis.process?.env ?? {};
	const path = settingsFilePath(env);
	if (path !== void 0) fileValue$1 = readSettingsFile(path);
	fileCheckedAt$1 = now;
	current$1 = resolveSettings(pluginConfig$1, env, fileValue$1);
	return current$1;
}
/**
* 写设置时的问题。
*
* 单独一个类型是为了让 HTTP 路由能把它映射成 400（用户输入问题）而不是 500（宿主故障）：
* 路由写错格式与文件写不进去，是两件该给用户不同提示的事。
*/
var SettingsWriteError = class extends Error {};
const processEnv = () => globalThis.process?.env ?? {};
function routeSource(env) {
	if (parseRoute(env["DSH_COMPLETION_ROUTE"]) !== void 0) return "env";
	if (fromConfig(fileValue$1).route !== void 0) return "file";
	if (fromConfig(pluginConfig$1).route !== void 0) return "config";
	return "default";
}
function fallbackSource(env) {
	if ((env["DSH_COMPLETION_FALLBACK"] ?? "").toLowerCase() === "local") return "env";
	if (typeof fromConfig(fileValue$1).fallback === "boolean") return "file";
	if (typeof fromConfig(pluginConfig$1).fallback === "boolean") return "config";
	return "default";
}
/** 用当前内存里的设置算视图，不读盘 —— 写入之后走这条，免得再读一次刚写的文件。 */
function settingsViewOf(env) {
	const path = settingsFilePath(env);
	return {
		route: current$1.route === void 0 ? null : `${current$1.route.provider}/${current$1.route.model}`,
		fallback: current$1.fallback,
		routeSource: routeSource(env),
		fallbackSource: fallbackSource(env),
		...path === void 0 ? {} : { file: path },
		envRoute: env["DSH_COMPLETION_ROUTE"] ?? null
	};
}
/** 设置页打开时读一次：立刻重读设置文件，不等两秒的重读周期。 */
function completionSettingsView(env = processEnv()) {
	refreshSettings();
	return settingsViewOf(env);
}
/** 原子写：先写临时文件再改名，中途断电也不会留下半份 JSON。 */
function systemSettingsIo() {
	const fs = nodeFs();
	return {
		read: (path) => {
			try {
				return JSON.parse(defaultReadFile(path));
			} catch {
				return;
			}
		},
		write: (path, value) => {
			if (fs?.writeFileSync === void 0 || fs.renameSync === void 0) throw new SettingsWriteError("宿主文件系统不可用，无法保存补全设置");
			const separator = path.lastIndexOf("/");
			if (separator > 0) fs.mkdirSync?.(path.slice(0, separator), { recursive: true });
			const temporary = `${path}.tmp`;
			fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
			fs.renameSync(temporary, path);
		}
	};
}
/**
* 把设置文件归一成 `{ completion: { route, fallback } }` 这一种形状。
*
* 早前的文件可能是平铺的 `{ route, fallback }`（`fromConfig` 两种都认）。写的时候统一收进
* `completion` 下面，否则一旦出现 `completion` 字段，平铺的旧值就会被 `fromConfig` 忽略而静默失效。
*/
function takeSettingsBucket(root) {
	const existing = root["completion"];
	if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) return { ...existing };
	const nested = {};
	for (const key of ["route", "fallback"]) if (key in root) {
		nested[key] = root[key];
		delete root[key];
	}
	return nested;
}
/**
* 写入补全设置并立刻生效。
*
* 为什么写文件而不是只改内存：模型路由与兜底开关由宿主执行，进程重启后必须还在；而这个文件正是
* 本插件既有的设置入口（设置页只是把它从「手改 JSON」变成可点的控件）。写完立刻重算一次，
* 用户不必等两秒的重读周期，更不必重启应用。
*/
function updateCompletionSettings(patch, env = processEnv(), io = systemSettingsIo()) {
	const path = settingsFilePath(env);
	if (path === void 0) throw new SettingsWriteError("数据目录未知（未设置 DSH_HOME），无法保存补全设置");
	const stored = io.read(path);
	const root = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? { ...stored } : {};
	const nested = takeSettingsBucket(root);
	if (patch.route !== void 0) {
		const raw = (patch.route ?? "").trim();
		if (raw === "") delete nested["route"];
		else {
			const route = parseRoute(raw);
			if (route === void 0) throw new SettingsWriteError("模型路由要写成 provider/model，例如 our-free-model/mimo-v2.6-flash-free");
			nested["route"] = `${route.provider}/${route.model}`;
		}
	}
	if (patch.fallback !== void 0) nested["fallback"] = patch.fallback;
	const next = {
		...root,
		completion: nested
	};
	if (Object.keys(nested).length === 0) delete next["completion"];
	io.write(path, next);
	fileValue$1 = next;
	fileCheckedAt$1 = Date.now();
	current$1 = resolveSettings(pluginConfig$1, env, fileValue$1);
	return settingsViewOf(env);
}
//#endregion
//#region src/completion/params.ts
const DEFAULT_COMPLETION_PARAMS = {
	debounceFastMs: 90,
	debounceSlowMs: 125,
	documentLines: 700,
	documentChars: 1e5,
	prefixChars: 7e3,
	prefixLines: 700,
	suffixChars: 4e3,
	suffixLines: 400,
	promptTokens: 3950,
	snippetCount: 4,
	snippetChars: 3e3,
	similarityThreshold: .15,
	candidateLimit: 3,
	completionTimeoutMs: 15e3,
	locateTimeoutMs: 5e3
};
function charBudgetForPrompt(params = DEFAULT_COMPLETION_PARAMS) {
	return params.promptTokens * 4;
}
//#endregion
//#region src/completion/protocol.ts
/** 把事件编码成一条 SSE 记录。 */
function encodeSseEvent(event) {
	return `data: ${JSON.stringify(event)}\n\n`;
}
//#endregion
//#region src/completion/dshProvider.ts
/**
* 对话式补全的停止串。
*
* 这里**不能**放代码围栏：对话模型往往一开头就输出 ```，把它当停止串会让生成刚起步就被截停、
* 结果一个字都拿不到。围栏改由后处理剥掉（见 filter.ts 的 stripCodeFence）。
*/
const COMPLETION_STOP = ["\n\n\n", "<CURSOR>"];
/**
* 把 DSH 的模型服务包成补全提供方。
*
* 每调用一次 `complete` 都重新取一次模型选择：用户可能在两分钟内改掉它，缓存住就会拿旧模型继续出结果。
* 取选择与开流都不做推理，开销可以接受。
*/
/**
* 打开一次补全流。
*
* DSH 的契约是「prepareCall 得到解析后的配置，再把该配置喂回 stream」；喂原始配置会被拒绝，
* 而适配器把它包成 TRANSPORT，看不出真正原因。
*
* 但适配器接口只强制 stream —— 第三方适配器可能没有 prepareCall，那条路会直接报方法不存在，
* 此时退回直接 stream（与旧行为一致）。
*/
async function openStream(llm, request, chosen) {
	try {
		const prepared = await llm.prepareCall({
			provider: request.provider,
			model: request.model,
			...request.sessionId === void 0 ? {} : { sessionId: request.sessionId },
			temperature: request.temperature,
			maxTokens: request.maxTokens,
			stop: request.stop
		}, request.signal);
		return prepared.stream({
			...request,
			...prepared.config
		});
	} catch (error) {
		console.warn("[dsh-completion] prepared 入口不可用，改用直接 stream：", error instanceof Error ? error.message : String(error));
		return llm.stream(request);
	}
}
function dshProvider(llm, defaultModel, options = {}) {
	options.params;
	const maxTokens = options.maxTokens ?? 256;
	const selection = () => options.selection ?? defaultModel.currentSelection();
	return {
		id: "dsh",
		get model() {
			return selection().model;
		},
		async *complete(prompt, context) {
			const chosen = selection();
			const stream = await openStream(llm, {
				provider: chosen.provider,
				model: chosen.model,
				...context.sessionId === "" ? {} : { sessionId: context.sessionId },
				temperature: 0,
				maxTokens,
				stop: COMPLETION_STOP,
				messages: [{
					role: "user",
					content: prompt
				}],
				signal: context.signal
			}, chosen);
			for await (const chunk of stream) {
				if (context.signal.aborted) return;
				if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
					yield {
						text: chunk.text,
						done: false
					};
					continue;
				}
				if (chunk.type === "finish") {
					const kind = chunk.reason?.kind;
					if (kind === "error") {
						const failure = chunk.reason?.failure;
						const parts = [
							failure?.message ?? "unknown error",
							failure?.code,
							failure?.status === void 0 ? void 0 : `status ${failure.status}`
						].filter((part) => part !== void 0).map((part) => String(part));
						throw new Error(`completion upstream failed (${chosen.provider}/${chosen.model}): ${parts.join(" · ")}`);
					}
					if (kind === "aborted") return;
					break;
				}
			}
			yield {
				text: "",
				done: true
			};
		}
	};
}
//#endregion
//#region src/completion/provider.ts
/**
* 模型提供方。
*
* 分成两个实现：
*   - `localCompletion`：不联网的兜底。用文档里出现过的标识符补全当前词，或在括号/引号未闭合时
*     补齐。它的价值有两条：链路可以在没有模型、没有密钥的情况下端到端跑通；没配模型时用户也不会
*     看到一个什么都不做的开关。
*   - `httpProvider`：OpenAI 兼容的 FIM 补全端点（`POST {baseUrl}/completions`，`stream: true`），
*     按流返回增量文本。地址、模型、密钥都由配置给，代码里不固化任何厂商。
*/
/** 光标左侧的标识符片段；没有就是空串。 */
function trailingIdentifier(prefix) {
	return /([A-Za-z_$][\w$]*)$/.exec(prefix)?.[1] ?? "";
}
/**
* 文档里出现过的、以 fragment 开头且更长的标识符，按离光标由近到远排序。
*
* 光标偏移必须由调用方给出：早先版本拿「文档长度的一半」当光标位置，排序结果与事实无关。
* 同一个标识符出现多次时取离光标最近的那次。
*/
function identifiersStartingWith(document, fragment, cursorOffset, limit) {
	if (fragment === "") return [];
	const found = /* @__PURE__ */ new Map();
	const pattern = /[A-Za-z_$][\w$]*/g;
	let match;
	while ((match = pattern.exec(document)) !== null) {
		const word = match[0];
		if (word === fragment || !word.startsWith(fragment)) continue;
		const distance = Math.abs(match.index - cursorOffset);
		const previous = found.get(word);
		if (previous === void 0 || distance < previous) found.set(word, distance);
	}
	return [...found.entries()].sort((left, right) => left[1] - right[1] || left[0].length - right[0].length).slice(0, limit).map(([word]) => word);
}
const CLOSERS = {
	"(": ")",
	"[": "]",
	"{": "}",
	"\"": "\"",
	"'": "'",
	"`": "`"
};
/**
* 从光标往前统计未闭合的括号与引号。
*
* 只看前缀，且引号按「成对出现」处理：代码里的引号大多成对，逐字符配对已经够用；真要做准需要词法
* 分析，那属于第二期结构解析的活。
*/
function unclosedClosers(prefix) {
	const stack = [];
	for (const char of prefix) {
		if (char in CLOSERS) {
			stack.push(CLOSERS[char]);
			continue;
		}
		if (stack.at(-1) === char) stack.pop();
	}
	return stack;
}
/**
* 本地兜底补全。
*
* 顺序：先用文档里的标识符补当前词（最贴近「他写了一半」的场景），再退到补齐未闭合的括号与引号。
* 两者都不适用时返回空数组 —— 宁可不给建议，也不要给一个无意义的建议。
*/
function localCompletion(prefix, suffix, params = DEFAULT_COMPLETION_PARAMS) {
	const fragment = trailingIdentifier(prefix);
	if (fragment.length >= 1) {
		const words = identifiersStartingWith(prefix + suffix, fragment, prefix.length, params.candidateLimit);
		if (words.length > 0) return words.map((word) => word.slice(fragment.length));
	}
	const closers = unclosedClosers(prefix);
	if (closers.length > 0) return [closers.at(-1)];
	return [];
}
/** 本地兜底作为提供方：把上面那套逻辑接到统一接口上。 */
function localProvider(params = DEFAULT_COMPLETION_PARAMS) {
	return {
		id: "local",
		model: "local-heuristic",
		async *complete(_prompt, context) {
			let index = 0;
			for (const text of localCompletion(context.prefix, context.suffix, params)) {
				if (context.signal.aborted) return;
				yield {
					text,
					done: false,
					index: index++
				};
			}
			yield {
				text: "",
				done: true
			};
		}
	};
}
/**
* OpenAI 兼容的 FIM 补全端点。
*
* 只认经典 completions 接口的流式返回：`data: {"choices":[{"text":"..."}]}`，以 `data: [DONE]` 结束。
* 这是多数代码模型暴露 FIM 能力的方式；要接 chat 接口应该在提供方这一层再加一个实现，而不是把
* 两套协议揉进一个函数。
*/
function httpProvider(config) {
	return {
		id: "http",
		model: config.model,
		async *complete(prompt, context) {
			const response = await fetch(new URL("completions", config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...config.apiKey === void 0 ? {} : { authorization: `Bearer ${config.apiKey}` },
					...config.headers
				},
				body: JSON.stringify({
					model: config.model,
					prompt,
					stream: true,
					max_tokens: config.maxTokens ?? 256,
					temperature: config.temperature ?? 0,
					...config.stop === void 0 ? {} : { stop: config.stop }
				}),
				signal: context.signal
			});
			if (!response.ok || response.body === null) throw new Error(`completion upstream failed: ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let boundary = buffer.indexOf("\n\n");
					while (boundary !== -1) {
						const record = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						boundary = buffer.indexOf("\n\n");
						for (const line of record.split("\n")) {
							if (!line.startsWith("data:")) continue;
							const data = line.slice(5).trim();
							if (data === "[DONE]") {
								yield {
									text: "",
									done: true
								};
								return;
							}
							try {
								const text = JSON.parse(data).choices?.[0]?.text;
								if (typeof text === "string" && text !== "") yield {
									text,
									done: false
								};
							} catch {}
						}
					}
				}
			} finally {
				if (context.signal.aborted) await reader.cancel().catch(() => void 0);
			}
			yield {
				text: "",
				done: true
			};
		}
	};
}
//#endregion
//#region src/completion/prompt.ts
const FIM_MARKERS = {
	/** <|fim_prefix|>前缀<|fim_suffix|>后缀<|fim_middle|> */
	psm: {
		prefix: "<|fim_prefix|>",
		suffix: "<|fim_suffix|>",
		middle: "<|fim_middle|>"
	},
	/** 全角变体，与另一族分词器一致。 */
	psmFullWidth: {
		prefix: "<｜fim▁begin｜>",
		suffix: "<｜fim▁end｜>",
		middle: "<｜fim▁hole｜>"
	},
	/** <fim_begin>前缀<fim_hole>后缀<fim_end> —— 三段式，标记在文本之间而不是两端。 */
	hole: {
		prefix: "<fim_begin>",
		middle: "<fim_hole>",
		suffix: "<fim_end>"
	}
};
const DEFAULT_PROMPT_PROFILE = {
	id: "default-psm",
	markers: FIM_MARKERS.psm,
	layout: "prefix-suffix-middle",
	suffixFromBlockBoundary: false
};
/**
* 对话模型的默认 profile。
*
* 光标处用 `<CURSOR>` 标出，指令里明确「只输出插入内容」—— 对话模型不做这个约束时，
* 十有八九会把上下文复述一遍或加上解释。
*/
const INSTRUCTION_PROMPT_PROFILE = {
	id: "instruction",
	markers: FIM_MARKERS.psm,
	layout: "instruction",
	suffixFromBlockBoundary: true
};
/** 光标占位符：指令排布与调试输出都用它。 */
const CURSOR_MARKER = "<CURSOR>";
/**
* 把「行号 1 起、列 1 起」换算成文档中的字符偏移。
*
* 行号与列号都从 1 开始 —— 这是 Monaco 的位置约定，也是请求里 `rewriteAt` 的约定。
* 列号若是 0 起，整个前缀会偏一个字符：光标在文档末尾时被长度夹住看不出来，光标在文件中段时
* 补全就会因为标识符对不上而消失（实测如此）。
*/
function offsetAt(document, line, column) {
	const lines = document.split("\n");
	const targetLine = Math.max(1, Math.min(line, lines.length));
	let offset = 0;
	for (let index = 0; index < targetLine - 1; index++) offset += (lines[index] ?? "").length + 1;
	return Math.min(offset + Math.max(0, column - 1), document.length);
}
/** 按行数与字符数双重封顶，保留靠近光标的那一侧。 */
function truncatePrefix(prefix, params) {
	const lines = prefix.split("\n");
	const byLines = lines.length > params.prefixLines ? lines.slice(lines.length - params.prefixLines).join("\n") : prefix;
	return byLines.length > params.prefixChars ? byLines.slice(byLines.length - params.prefixChars) : byLines;
}
function truncateSuffix(suffix, params) {
	const lines = suffix.split("\n");
	const byLines = lines.length > params.suffixLines ? lines.slice(0, params.suffixLines).join("\n") : suffix;
	return byLines.length > params.suffixChars ? byLines.slice(0, params.suffixChars) : byLines;
}
/** 后缀块边界扫描的行数上限；请求裁剪也用它，保证两边看的是同一个后缀窗口。 */
const SUFFIX_BLOCK_SCAN_LINES = 200;
/**
* 从最近的同级代码块边界起截取后缀。
*
* 做法：在光标之后的前若干行里，找到第一条缩进不超过光标行缩进、且非空的行，从那里开始取。
* 缩进敏感的语言里这样能避免把当前块的残尾喂给模型。
*/
function suffixFromBlockBoundary(suffix, currentIndent) {
	const lines = suffix.split("\n");
	for (let index = 1; index < Math.min(lines.length, SUFFIX_BLOCK_SCAN_LINES); index++) {
		const text = lines[index] ?? "";
		if (text.trim() === "") continue;
		if (text.length - text.trimStart().length <= currentIndent) return lines.slice(index).join("\n");
	}
	return suffix;
}
/** 当前行的缩进宽度。 */
function indentOf(text) {
	const line = text.slice(text.lastIndexOf("\n") + 1);
	return line.length - line.trimStart().length;
}
/**
* 随请求发送的文档内容裁剪（文档 4.3）：按行数与字符数双重封顶，保留靠近光标的部分。
*
* 裁剪会把行号整体前移，所以重写位置必须一起换算 —— 否则模型收到的「光标位置」与实际文本对不上。
*/
function truncateDocument(document, rewriteAt, params) {
	const lines = document.split("\n");
	let kept = document;
	let droppedLines = 0;
	if (lines.length > params.documentLines) {
		const cursorIndex = Math.max(0, Math.min(rewriteAt.line - 1, lines.length - 1));
		const before = Math.min(cursorIndex, Math.max(0, params.documentLines - 200));
		const start = Math.max(0, cursorIndex - before);
		const end = Math.min(lines.length, start + params.documentLines);
		const finalStart = Math.max(0, end - params.documentLines);
		kept = lines.slice(finalStart, end).join("\n");
		droppedLines = finalStart;
	}
	let column = rewriteAt.column;
	if (kept.length > params.documentChars) {
		const keptLines = kept.split("\n");
		let startLine = 0;
		let remaining = kept.length;
		while (keptLines.length - startLine > 1 && remaining > params.documentChars) {
			remaining -= (keptLines[startLine] ?? "").length + 1;
			startLine++;
			droppedLines++;
		}
		kept = keptLines.slice(startLine).join("\n");
		if (kept.length > params.documentChars) {
			const cut = kept.length - params.documentChars;
			kept = kept.slice(cut);
			if (rewriteAt.line - droppedLines <= 1) column = Math.max(1, column - cut);
		}
	}
	return {
		document: kept,
		rewriteAt: {
			line: Math.max(1, rewriteAt.line - droppedLines),
			column
		}
	};
}
/**
* 组装上下文段。
*
* 按文档给的丢弃优先级从低到高判断：先丢仓库级上下文，再丢检索片段，再丢符号定义，
* 最后才动编辑历史；前后缀属于生成必要输入，不在这里处理。
*/
function assembleContext(input, budgetChars, symbolBudgetChars = Number.POSITIVE_INFINITY) {
	const dropped = [];
	const parts = [];
	if (input.repositoryContext !== void 0 && input.repositoryContext.trim() !== "") parts.push({
		label: "仓库级上下文",
		text: input.repositoryContext
	});
	for (const snippet of input.snippets ?? []) if (snippet.trim() !== "") parts.push({
		label: "检索片段",
		text: snippet
	});
	let symbolChars = 0;
	for (const symbol of input.symbols ?? []) {
		if (symbol.trim() === "") continue;
		symbolChars += symbol.length;
		if (symbolChars > symbolBudgetChars) {
			dropped.push("符号定义");
			continue;
		}
		parts.push({
			label: "符号定义",
			text: symbol
		});
	}
	const history = (input.edits ?? []).map((entry) => `- 改前：${entry.before}\n  改后：${entry.after}`).join("\n");
	if (history !== "") parts.push({
		label: "编辑历史",
		text: history
	});
	const sizeOf = (part) => part.text.length + part.label.length + 8;
	const kept = [...parts];
	let used = kept.reduce((sum, part) => sum + sizeOf(part), 0);
	while (used > budgetChars && kept.length > 1) {
		const gone = kept.shift();
		if (gone !== void 0) {
			dropped.push(gone.label);
			used -= sizeOf(gone);
		}
	}
	if (used > budgetChars && kept.length === 1) {
		const only = kept[0];
		if (only !== void 0) {
			dropped.push(only.label);
			kept.length = 0;
		}
	}
	return {
		context: kept.map((part) => part.label === "编辑历史" ? `# 最近的编辑\n${part.text}` : `# ${part.label}\n${part.text}`).join("\n\n"),
		dropped
	};
}
/** 按 profile 的排布方式把三段拼成一个 prompt。 */
function renderPrompt(prefix, suffix, profile) {
	const { markers } = profile;
	if (profile.layout === "begin-hole-end") return `${markers.prefix}${prefix}${markers.middle}${suffix}${markers.suffix}`;
	if (profile.layout === "instruction") return [
		"你是代码补全引擎。只输出应当插入在光标处的内容，不要解释，不要加代码块围栏，不要复述光标之前已经写过的代码，也不要重复光标之后已有的代码。",
		"如果补不出内容，输出空行。",
		"",
		`光标位置标为 ${CURSOR_MARKER}。`,
		"",
		"<代码>",
		`${prefix}${CURSOR_MARKER}${suffix}`,
		"</代码>"
	].join("\n");
	return `${markers.prefix}${prefix}${markers.suffix}${suffix}${markers.middle}`;
}
/**
* 组装一次补全请求的完整 prompt。
*
* 生成段里保留文件路径标记：模型据此判断语言与项目约定，这一条在文档的序列结构里是显式给出的。
*/
function assemblePrompt(input, params = DEFAULT_COMPLETION_PARAMS, profile = DEFAULT_PROMPT_PROFILE) {
	const offset = offsetAt(input.document, input.rewriteAt.line, input.rewriteAt.column);
	const rawPrefix = input.document.slice(0, offset);
	let rawSuffix = input.document.slice(offset);
	if (profile.suffixFromBlockBoundary) rawSuffix = suffixFromBlockBoundary(rawSuffix, indentOf(rawPrefix));
	const prefix = truncatePrefix(rawPrefix, params);
	const suffix = truncateSuffix(rawSuffix, params);
	const totalBudget = charBudgetForPrompt(params);
	const { context, dropped } = assembleContext(input, Math.max(0, totalBudget - prefix.length - suffix.length), Math.floor(totalBudget * .1));
	const generation = `# 文件：${input.filePath}\n${renderPrompt(prefix, suffix, profile)}`;
	const prompt = context === "" ? generation : `${context}\n\n${generation}`;
	return {
		prompt,
		prefix,
		suffix,
		dropped,
		chars: prompt.length,
		snippetCount: input.snippets?.length ?? 0
	};
}
//#endregion
//#region src/completion/security.ts
/**
* 默认规则集。
*
* 只收「几乎不可能是正常代码」的模式：私钥块、云厂商与代码托管的固定格式令牌、硬编码凭据字面量。
* 刻意不收宽泛的「疑似密钥」启发式 —— 那类规则会把正常代码拦下来，而误拦的代价是补全直接消失。
*/
const DEFAULT_SECURITY_RULES = [
	{
		id: "private-key-block",
		name: "私钥块",
		action: "block",
		pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----"
	},
	{
		id: "aws-access-key",
		name: "AWS 访问密钥",
		action: "block",
		pattern: "\\bAKIA[0-9A-Z]{16}\\b"
	},
	{
		id: "github-token",
		name: "代码托管令牌",
		action: "block",
		pattern: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b"
	},
	{
		id: "generic-credential",
		name: "硬编码凭据",
		action: "mask",
		pattern: "(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*['\"][^'\"]{8,}['\"]"
	}
];
/** 编译一条规则；模式非法时退化为字面匹配，不让一条坏规则拖垮整轮补全。 */
function compileRule(rule) {
	if (rule.pattern === void 0 || rule.pattern === "") {
		const name = rule.name;
		if (name === "") return () => false;
		return (text) => text.includes(name);
	}
	try {
		const expression = new RegExp(rule.pattern, "i");
		return (text) => expression.test(text);
	} catch {
		return (text) => text.includes(rule.name);
	}
}
/**
* 判定一段文本命中了哪条规则。
*
* 多条命中时取更严的动作（拦截优先于脱敏）：宁可少给一次补全，也不要把拦不住的东西标成脱敏。
* 同动作下按规则集顺序取第一条，保证结果稳定可测。
*/
function evaluateSecurity(text, rules) {
	if (text === "") return void 0;
	let masked;
	for (const rule of rules) {
		if (!compileRule(rule)(text)) continue;
		const hit = {
			action: rule.action,
			ruleId: rule.id,
			ruleName: rule.name
		};
		if (rule.action === "block") return hit;
		masked ??= hit;
	}
	return masked;
}
/** 请求里带租户规则时用它，否则用默认集。空数组视为「显式关闭」，不回退到默认集。 */
function rulesForRequest(rules) {
	return rules === void 0 ? DEFAULT_SECURITY_RULES : rules.rules;
}
//#endregion
//#region src/completion/service.ts
/**
* 一次补全请求的编排：裁剪 → 组装 → 模型 → 事件流。
*
* 这一层不碰 HTTP：它只把事件按顺序产出来，宿主的路由负责写成 SSE。这样编排可以脱离网络单测，
* 换传输方式（比如改成 WebSocket 或直接进程内调用）也不必改这里。
*/
/**
* 给一次异步操作套上等待上限。
*
* 超时不会取消底层工作（磁盘上的扫描没有取消点），只是不再等它：补全按「没有片段」继续。
*/
async function withTimeout$1(work, timeoutMs) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve([]), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
async function* runCompletion(request, options) {
	const params = options.params ?? DEFAULT_COMPLETION_PARAMS;
	const now = options.now ?? (() => Date.now());
	const started = now();
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (options.signal?.aborted === true) controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, params.completionTimeoutMs);
	let accumulated = "";
	const securityRules = rulesForRequest(request.security);
	try {
		const truncated = truncateDocument(request.cursor.document, request.cursor.rewriteAt, params);
		const snippets = options.retrieve === void 0 ? [] : await withTimeout$1(Promise.resolve().then(() => options.retrieve?.(request, params)).catch(() => []), params.locateTimeoutMs);
		const assembled = assemblePrompt({
			filePath: request.cursor.filePath,
			language: request.language,
			document: truncated.document,
			rewriteAt: truncated.rewriteAt,
			edits: request.edits,
			snippets
		}, params, options.profile);
		if (controller.signal.aborted) return;
		yield {
			type: "meta",
			model: options.provider.model,
			...request.environment.experiment === void 0 ? {} : { experiment: request.environment.experiment },
			snippets: assembled.snippetCount
		};
		for await (const chunk of options.provider.complete(assembled.prompt, {
			signal: controller.signal,
			sessionId: request.sessionId,
			language: request.language,
			params,
			prefix: assembled.prefix,
			suffix: assembled.suffix
		})) {
			if (controller.signal.aborted) return;
			if (chunk.done || chunk.text === "") continue;
			accumulated += chunk.text;
			const hit = evaluateSecurity(accumulated, securityRules);
			if (hit !== void 0) {
				yield {
					type: "content_security",
					...hit
				};
				options.onSecurityHit?.(hit, request);
				if (hit.action === "block") return;
			}
			const candidateIndex = chunk.index ?? 0;
			yield {
				type: "output",
				candidates: [{
					index: candidateIndex,
					text: chunk.text,
					finishReason: "",
					elapsedMs: now() - started
				}]
			};
			if (candidateIndex + 1 >= params.candidateLimit) break;
		}
	} catch (error) {
		if (timedOut) {
			yield {
				type: "error",
				code: "completion-timeout",
				message: `no completion within ${params.completionTimeoutMs} ms`
			};
			return;
		}
		if (!controller.signal.aborted) {
			yield {
				type: "error",
				code: "completion-failed",
				message: error instanceof Error ? error.message : String(error)
			};
			return;
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
	if (timedOut) {
		yield {
			type: "error",
			code: "completion-timeout",
			message: `no completion within ${params.completionTimeoutMs} ms`
		};
		return;
	}
	if (controller.signal.aborted) return;
	yield { type: "done" };
}
//#endregion
//#region src/completion/diagnostics.ts
/**
* 追加一行补全诊断日志。
*
* 为什么需要：应用侧的启动窗口日志拿不到，而「没有补全」至少有三种原因 ——
* 客户端没发请求、请求到了但选路不对、模型调用失败。这三件事只能从宿主侧区分，
* 所以固定写进一个文件（与设置文件同级的 completion.log）。
*
* 日志只用于排查，不参与任何决策；写失败也不影响补全。
*/
function noteCompletion(line) {
	const path = diagnosticLogPath();
	if (path === void 0) return;
	appendFile(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, "utf8").catch(() => {});
}
//#endregion
//#region src/completion/chunks.ts
const DEFAULT_CHUNK_LIMITS = {
	maxFileBytes: 1048576,
	maxAverageLineLength: 500,
	maxChunksPerFile: 40,
	maxChunkChars: 3e3,
	windowLines: 40
};
/** 文件级跳过判定；返回原因表示跳过，返回 undefined 表示参与索引。 */
function shouldSkipFile(size, text, limits = DEFAULT_CHUNK_LIMITS) {
	if (size > limits.maxFileBytes) return "file-too-large";
	const lines = text.split("\n");
	if (lines.length > 0 && text.length / lines.length > limits.maxAverageLineLength) return "average-line-too-long";
	if (text.includes("\0")) return "binary";
}
const C_LIKE = /* @__PURE__ */ new Set([
	"typescript",
	"typescriptreact",
	"javascript",
	"javascriptreact",
	"java",
	"c",
	"cpp",
	"csharp",
	"go",
	"rust",
	"php",
	"swift",
	"kotlin",
	"scss",
	"less",
	"css",
	"json",
	"jsonc"
]);
const PYTHON_LIKE = /* @__PURE__ */ new Set(["python", "ruby"]);
/** 在给定语言下识别实体起始行的模式。未识别的语言返回 undefined，由窗口兜底。 */
const PATTERNS = {
	c: [
		{
			kind: "class",
			pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
		},
		{
			kind: "class",
			pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/
		},
		{
			kind: "class",
			pattern: /^\s*(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/
		},
		{
			kind: "function",
			pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
		},
		{
			kind: "function",
			pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/
		}
	],
	python: [{
		kind: "class",
		pattern: /^(\s*)class\s+([A-Za-z_]\w*)/
	}, {
		kind: "function",
		pattern: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/
	}]
};
function patternKey(language) {
	const normalized = language.trim().toLowerCase();
	if (C_LIKE.has(normalized)) return "c";
	if (PYTHON_LIKE.has(normalized)) return "python";
}
/** C 系：从起始行按花括号配平找实体结束行。 */
function endByBraces(lines, start) {
	let depth = 0;
	let seenBrace = false;
	for (let index = start; index < lines.length; index++) {
		const line = lines[index] ?? "";
		for (const char of line) if (char === "{") {
			depth++;
			seenBrace = true;
		} else if (char === "}") depth--;
		if (seenBrace && depth <= 0) return index;
		if (!seenBrace && line.trimEnd().endsWith(";")) return index;
	}
	return lines.length - 1;
}
/** Python 系：实体边界由缩进决定，回到起始缩进即结束。 */
function endByIndent(lines, start, indent) {
	let last = start;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim() === "") continue;
		if (line.length - line.trimStart().length <= indent) break;
		last = index;
	}
	return last;
}
/**
* 抽取一个文件的块。
*
* 产出顺序：一个模块块（文件头若干行，回答「这个文件是什么」）+ 各实体块。没有任何实体可识别时
* 退化为定长窗口，保证每个文件都有可检索内容。
*/
function extractChunks(path, language, text, limits = DEFAULT_CHUNK_LIMITS) {
	const lines = text.split("\n");
	const chunks = [];
	const push = (kind, name, start, end) => {
		if (chunks.length >= limits.maxChunksPerFile) return;
		const body = lines.slice(start, end + 1).join("\n");
		if (body.trim() === "") return;
		const trimmed = body.length > limits.maxChunkChars ? body.slice(0, limits.maxChunkChars) : body;
		chunks.push({
			path,
			language,
			kind,
			...name === void 0 ? {} : { name },
			startLine: start + 1,
			endLine: Math.min(end + 1, lines.length),
			text: trimmed,
			embeddingText: trimmed
		});
	};
	push("module", void 0, 0, Math.min(lines.length - 1, 39));
	const key = patternKey(language);
	if (key === "c") for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.length - line.trimStart().length > 2) continue;
		for (const { kind, pattern } of PATTERNS["c"]) {
			const match = pattern.exec(line);
			if (match?.[1] === void 0) continue;
			push(kind, match[1], index, endByBraces(lines, index));
			index = endByBraces(lines, index);
			break;
		}
	}
	else if (key === "python") for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		for (const { kind, pattern } of PATTERNS["python"]) {
			const match = pattern.exec(line);
			if (match?.[2] === void 0) continue;
			const indent = (match[1] ?? "").length;
			push(kind, match[2], index, endByIndent(lines, index, indent));
			index = endByIndent(lines, index, indent);
			break;
		}
	}
	if (chunks.length <= 1 && lines.length > limits.windowLines) for (let start = 0; start < lines.length; start += limits.windowLines) push("window", void 0, start, Math.min(start + limits.windowLines - 1, lines.length - 1));
	return chunks;
}
//#endregion
//#region src/completion/embedding.ts
/** 把代码切成查询与嵌入用的词元：标识符按驼峰与下划线拆开，另收字面量。 */
function tokenizeCode(text) {
	const tokens = [];
	const pattern = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const raw = match[0];
		if (raw.startsWith("\"") || raw.startsWith("'") || raw.startsWith("`")) {
			tokens.push(raw.slice(1, -1));
			continue;
		}
		const parts = raw.split(/[_\s]+/).flatMap((part) => part.split(/(?=[A-Z])/).map((value) => value.toLowerCase())).filter((value) => value !== "");
		tokens.push(...parts);
	}
	return tokens;
}
/** 字符 n 连：中文标识符、拼接字符串这类词元切不干净的内容靠它兜住。 */
function charNGrams(text, size = 3) {
	const normalized = text.replace(/\s+/g, " ");
	const grams = [];
	for (let index = 0; index + size <= normalized.length; index++) grams.push(normalized.slice(index, index + size));
	return grams;
}
/** 稳定的 32 位哈希：同一输入在任何进程里都得到同一结果，便于索引落盘后复用。 */
function hashFeature(feature) {
	let hash = 2166136261;
	for (let index = 0; index < feature.length; index++) {
		hash ^= feature.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}
const DEFAULT_EMBEDDING_DIMENSIONS = 256;
/**
* 特征哈希嵌入。
*
* 词频取次线性（1 + log tf），避免长文件在向量里压过短文件；负号哈希用于抵消碰撞的系统性偏移，
* 这是哈希技巧的常规做法。
*/
function hashingEmbedder(dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
	return {
		id: `hashing-${dimensions}`,
		dimensions,
		embed(text) {
			const vector = new Float32Array(dimensions);
			const counts = /* @__PURE__ */ new Map();
			for (const token of tokenizeCode(text)) counts.set(`w:${token}`, (counts.get(`w:${token}`) ?? 0) + 1);
			for (const gram of charNGrams(text)) counts.set(`g:${gram}`, (counts.get(`g:${gram}`) ?? 0) + 1);
			for (const [feature, count] of counts) {
				const hash = hashFeature(feature);
				const index = hash % dimensions;
				const sign = (hash & 2147483648) === 0 ? 1 : -1;
				vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(count));
			}
			return l2Normalize(vector);
		}
	};
}
/** 就地做 L2 归一化；零向量原样返回（余弦相似度此时定义为 0）。 */
function l2Normalize(vector) {
	let sum = 0;
	for (const value of vector) sum += value * value;
	if (sum === 0) return vector;
	const norm = Math.sqrt(sum);
	for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm;
	return vector;
}
/** 余弦相似度。输入已归一化时就是点积；这里不假设已归一化。 */
function cosineSimilarity(left, right) {
	const length = Math.min(left.length, right.length);
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < length; index++) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
//#endregion
//#region src/completion/retrieval.ts
/**
* 本地向量索引与检索（文档 5.3、5.4）。
*
* 存储形态：按项目分库 —— 一个工作区根目录对应一个索引文件，内容是块 + 向量 + 文件指纹。
* 没有用 SQLite：插件宿主在桌面端跑在 Electron 的 Node 里，`node:sqlite` 不保证存在；而索引规模
* 由上限约束（文件数、块数、总量），暴力余弦在这个量级是毫秒级。存储与检索都在 `RetrievalIndex`
* 这一个接口后面，要换成嵌入式向量库时替换它即可。
*
* 维护策略按文档 5.3：首次全量、按周期重建、文件变更增量更新、预算上限封顶。
*/
const DEFAULT_INDEX_LIMITS = {
	maxFiles: 4e3,
	maxChunks: 12e3
};
/** 常见语言关键字与类型名：它们几乎出现在每个分块里，不构成「相关」的证据。 */
const COMMON_TOKENS = /* @__PURE__ */ new Set([
	"const",
	"let",
	"var",
	"function",
	"return",
	"import",
	"export",
	"default",
	"async",
	"await",
	"class",
	"interface",
	"type",
	"enum",
	"extends",
	"implements",
	"public",
	"private",
	"protected",
	"static",
	"readonly",
	"string",
	"number",
	"boolean",
	"void",
	"null",
	"undefined",
	"true",
	"false",
	"this",
	"super",
	"new",
	"typeof",
	"instanceof",
	"while",
	"for",
	"switch",
	"case",
	"break",
	"catch",
	"finally",
	"throw",
	"error",
	"value",
	"items",
	"index",
	"length",
	"name",
	"path",
	"text"
]);
/** 片段正文的取用键：同一文件的不同行范围必须能区分开。 */
function snippetKey(snippet) {
	return `${snippet.path}:${snippet.startLine}-${snippet.endLine}`;
}
/**
* 分块内容哈希（文档 5.2 的去重依据）。
*
* 用 SHA-1 而不是短哈希：短哈希碰撞会让一段合法代码被当成重复丢掉，而这里哈希只是内存与
* 索引文件里的一份字符串，代价可以忽略。
*/
const hashOf = (text) => createHash("sha1").update(text).digest("hex");
/** 向量按 Float32 的 base64 落盘：JSON 数组里每个分量约 19 个字符，实测索引体积的绝大部分是它。 */
function encodeVector(vector) {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}
function decodeVector(encoded) {
	const buffer = Buffer.from(encoded, "base64");
	return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}
/**
* 从光标附近的代码构造查询（文档 5.3 第 1 条）。
*
* 取光标所在行向前后各若干行：既要标识符与字面量，也要保留原始文本片段 —— 只取标识符会丢掉
* 「这些标识符是怎么组合的」这一层信息。
*/
function buildQuery(document, line, column, windowLines = 30) {
	const lines = document.split("\n");
	const cursor = Math.max(0, Math.min(line - 1, lines.length - 1));
	const start = Math.max(0, cursor - windowLines);
	Math.min(lines.length, cursor + 2);
	const before = (lines[cursor] ?? "").slice(0, Math.max(0, column - 1));
	return `${before}\n${before}\n${lines.slice(start, cursor).join("\n")}`;
}
var RetrievalIndex = class {
	embedder;
	chunkLimits;
	limits;
	options;
	stored = /* @__PURE__ */ new Map();
	/** 已入库分块的内容哈希：文档 5.2 的去重依据。重建与载入时一并恢复。 */
	hashes = /* @__PURE__ */ new Set();
	files = /* @__PURE__ */ new Map();
	builtAt = 0;
	dirty = false;
	constructor(options) {
		this.options = options;
		this.embedder = options.embedder ?? hashingEmbedder();
		this.chunkLimits = options.chunkLimits ?? DEFAULT_CHUNK_LIMITS;
		this.limits = options.indexLimits ?? DEFAULT_INDEX_LIMITS;
	}
	status(now = Date.now()) {
		let chunks = 0;
		for (const list of this.stored.values()) chunks += list.length;
		return {
			storePath: this.options.storePath,
			embedder: this.embedder.id,
			files: this.stored.size,
			chunks,
			builtAt: this.builtAt,
			stale: this.builtAt === 0 || now - this.builtAt > this.options.rebuildIntervalMs,
			limits: this.limits,
			capped: this.stored.size >= this.limits.maxFiles || chunks >= this.limits.maxChunks
		};
	}
	/** 从磁盘载入索引；文件不存在或版本不符时当作空索引。 */
	async load() {
		try {
			const parsed = JSON.parse(await readFile(this.options.storePath, "utf8"));
			if (parsed.version !== 3 || parsed.embedder !== this.embedder.id) return;
			this.builtAt = parsed.builtAt;
			this.files = new Map(Object.entries(parsed.files));
			this.stored = /* @__PURE__ */ new Map();
			this.hashes.clear();
			for (const chunk of parsed.chunks) {
				const list = this.stored.get(chunk.path) ?? [];
				list.push(chunk);
				this.stored.set(chunk.path, list);
				this.hashes.add(chunk.hash);
			}
		} catch {}
	}
	async save() {
		if (!this.dirty) return;
		const chunks = [];
		for (const list of this.stored.values()) chunks.push(...list);
		const payload = {
			version: 3,
			embedder: this.embedder.id,
			builtAt: this.builtAt,
			files: Object.fromEntries(this.files),
			chunks
		};
		await mkdir(dirname(this.options.storePath), { recursive: true });
		await writeFile(this.options.storePath, JSON.stringify(payload), "utf8");
		this.dirty = false;
	}
	/** 该重建吗：空索引、超过周期，或调用方要求强制。 */
	needsRebuild(now = Date.now()) {
		return this.builtAt === 0 || now - this.builtAt > this.options.rebuildIntervalMs;
	}
	/**
	* 这个文件需要重读吗。
	*
	* 增量扫描先问后读：mtime 与大小都没变就不必把文件内容读进来，这是「文件变更时增量更新」
	* （文档 5.3）在有上限的索引预算下真正省时间的地方。
	*/
	needsUpdate(path, mtimeMs, size) {
		const previous = this.files.get(path);
		return previous === void 0 || previous.mtimeMs !== mtimeMs || previous.size !== size;
	}
	/** 索引（或跳过）一个文件；mtime 与大小都没变则视为未变，直接跳过重建向量。 */
	update(file) {
		const previous = this.files.get(file.path);
		if (previous !== void 0 && previous.mtimeMs === file.mtimeMs && previous.size === file.size) return "unchanged";
		if (!this.stored.has(file.path) && this.stored.size >= this.limits.maxFiles) return "skipped";
		if (shouldSkipFile(file.size, file.text, this.chunkLimits) !== void 0) {
			this.stored.delete(file.path);
			this.files.delete(file.path);
			this.dirty = true;
			return "skipped";
		}
		let totalChunks = 0;
		for (const list of this.stored.values()) totalChunks += list.length;
		if (totalChunks >= this.limits.maxChunks) return "skipped";
		const seen = this.hashes;
		const chunks = extractChunks(file.path, file.language, file.text, this.chunkLimits).filter((chunk) => {
			const hash = hashOf(chunk.embeddingText);
			if (seen.has(hash)) return false;
			seen.add(hash);
			return true;
		}).map((chunk) => ({
			path: chunk.path,
			kind: chunk.kind,
			...chunk.name === void 0 ? {} : { name: chunk.name },
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			hash: hashOf(chunk.embeddingText),
			tokens: Array.from(new Set(tokenizeCode(chunk.embeddingText))).slice(0, 48),
			vector: encodeVector(this.embedder.embed(chunk.embeddingText))
		}));
		this.stored.set(file.path, chunks);
		this.files.set(file.path, {
			mtimeMs: file.mtimeMs,
			size: file.size,
			chunks: chunks.length
		});
		this.builtAt = Date.now();
		this.dirty = true;
		return chunks.length === 0 ? "skipped" : "indexed";
	}
	remove(path) {
		for (const chunk of this.stored.get(path) ?? []) this.hashes.delete(chunk.hash);
		if (this.stored.delete(path)) this.dirty = true;
		if (this.files.delete(path)) this.dirty = true;
	}
	clear() {
		this.stored.clear();
		this.files.clear();
		this.hashes.clear();
		this.builtAt = 0;
		this.dirty = true;
	}
	/**
	* 检索：先按余弦召回，再按「余弦 + 词级 Jaccard」重排（文档 5.3 第 4 条、5.4）。
	*
	* 排除当前正在编辑的文件：它的内容已经在前缀里了，片段上下文的价值在于跨文件复用模式。
	*/
	search(query, excludePath, now = Date.now()) {
		const queryVector = this.embedder.embed(query);
		const queryTokens = new Set(tokenizeCode(query).filter((token) => token.length >= 4 && !COMMON_TOKENS.has(token.toLowerCase())));
		const scored = [];
		for (const [path, list] of this.stored) {
			if (path === excludePath) continue;
			for (const chunk of list) {
				if (chunk.endLine - chunk.startLine < 1) continue;
				const overlap = queryTokens.size === 0 ? 0 : [...queryTokens].filter((token) => chunk.tokens?.includes(token) === true).length / queryTokens.size;
				const cosine = cosineSimilarity(queryVector, decodeVector(chunk.vector));
				if (cosine < this.options.similarityThreshold) continue;
				if (queryTokens.size > 0 && overlap === 0) continue;
				const rerank = .5 * cosine + .5 * overlap;
				scored.push({
					chunk,
					cosine,
					score: rerank
				});
			}
		}
		scored.sort((left, right) => right.score - left.score);
		return scored.slice(0, this.options.snippetCount).map(({ chunk, score }) => ({
			path: chunk.path,
			kind: chunk.kind,
			...chunk.name === void 0 ? {} : { name: chunk.name },
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			score: Number(score.toFixed(4))
		}));
	}
	/** 单片段字符上限，供调用方按同一口径截断。 */
	get snippetChars() {
		return this.options.snippetChars;
	}
};
/**
* 把检索结果与取回的正文拼成注入 prompt 的片段文本。
*
* `texts` 按 `snippetKey` 取用：同一文件的不同行范围是不同的键，不会互相覆盖。
*/
function formatSnippets(snippets, texts, maxChars) {
	const out = [];
	for (const snippet of snippets) {
		const body = texts.get(snippetKey(snippet));
		if (body === void 0) continue;
		const header = `// ${snippet.path}:${snippet.startLine}-${snippet.endLine}${snippet.name === void 0 ? "" : ` (${snippet.kind} ${snippet.name})`}`;
		out.push(`${header}\n${body.length > maxChars ? body.slice(0, maxChars) : body}`);
	}
	return out;
}
//#endregion
//#region src/completion/workspaceIndex.ts
/**
* 工作区索引器：把磁盘上的代码送进检索索引，并按项目提供检索入口（文档 5.1、5.3）。
*
* 索引文件放在工作区内的 `.dsh-workbench/index.json`：按项目分库（文档 5.3），且不写系统盘。
* 该目录自身被排除在索引之外，避免索引把自己的产物也收进去。
*
* 增量策略：扫描时先问 `needsUpdate`，未变更的文件不读内容；全量重建由周期（默认 24 小时）或
* 显式刷新触发。刷新在后台进行，不阻塞补全请求 —— 检索没就绪时按「没有片段」继续。
*/
/** 片段读取按行扫描时的块大小。命中行靠前时可以只读文件开头。 */
const SNIPPET_READ_CHUNK_BYTES = 262144;
/** 索引自身的产物与常见依赖/构建目录都排除在外。 */
const INDEX_IGNORED_DIRS = /* @__PURE__ */ new Set([
	".git",
	".dsh-workbench",
	"node_modules",
	"dist",
	"out",
	"build",
	"lib",
	"coverage",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"tmp",
	"target",
	"vendor",
	".idea",
	".vscode-test"
]);
/** 参与索引的扩展名到语言标识的映射。没有映射的文件不参与索引。 */
const LANGUAGE_BY_EXTENSION$1 = /* @__PURE__ */ new Map([
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascriptreact"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".rb", "ruby"],
	[".go", "go"],
	[".rs", "rust"],
	[".java", "java"],
	[".c", "c"],
	[".h", "c"],
	[".cpp", "cpp"],
	[".hpp", "cpp"],
	[".cc", "cpp"],
	[".cs", "csharp"],
	[".php", "php"],
	[".swift", "swift"],
	[".kt", "kotlin"],
	[".lua", "lua"],
	[".sh", "shell"],
	[".ps1", "powershell"],
	[".sql", "sql"],
	[".css", "css"],
	[".scss", "scss"],
	[".less", "less"],
	[".html", "html"],
	[".vue", "vue"],
	[".svelte", "svelte"],
	[".yml", "yaml"],
	[".yaml", "yaml"],
	[".toml", "toml"],
	[".json", "json"]
]);
var WorkspaceIndex = class WorkspaceIndex {
	options;
	index;
	refreshing;
	constructor(options, index) {
		this.options = options;
		this.index = index;
	}
	static async open(options) {
		const index = new RetrievalIndex({
			storePath: options.storePath ?? join(options.root, ".dsh-workbench", "index.json"),
			snippetCount: options.params.snippetCount,
			snippetChars: options.params.snippetChars,
			similarityThreshold: options.params.similarityThreshold,
			rebuildIntervalMs: 864e5
		});
		await index.load();
		await mkdir(join(options.root, ".dsh-workbench"), { recursive: true }).catch(() => void 0);
		await writeFile(join(options.root, ".dsh-workbench", ".gitignore"), "*\n", "utf8").catch(() => void 0);
		return new WorkspaceIndex(options, index);
	}
	status() {
		return {
			...this.index.status(),
			root: this.options.root
		};
	}
	/** 需要时（首次或过期）在后台刷新，返回同一个进行中的任务。 */
	ensureFresh() {
		if (this.refreshing !== void 0) return this.refreshing;
		if (!this.index.needsRebuild()) return void 0;
		return this.refresh();
	}
	/**
	* 全量扫描并增量更新索引。
	*
	* 进行中的任务由本方法自己持有并复用：后台刷新与手动重建同时发生时，同一份索引只扫一遍。
	* 因此它不是 async 函数 —— async 会让每次调用都包出一个新 promise，复用就无从谈起。
	*/
	refresh() {
		if (this.refreshing !== void 0) return this.refreshing;
		const running = this.runRefresh().finally(() => {
			if (this.refreshing === running) this.refreshing = void 0;
		});
		this.refreshing = running;
		return running;
	}
	async runRefresh() {
		const started = Date.now();
		const report = {
			scanned: 0,
			indexed: 0,
			unchanged: 0,
			skipped: 0,
			chunks: 0,
			durationMs: 0
		};
		const candidates = [];
		const walk = async (directory) => {
			let entries;
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const absolute = join(directory, entry.name);
				if (entry.isDirectory()) {
					if (INDEX_IGNORED_DIRS.has(entry.name)) continue;
					await walk(absolute);
					continue;
				}
				if (!entry.isFile()) continue;
				const dot = entry.name.lastIndexOf(".");
				const language = dot === -1 ? void 0 : LANGUAGE_BY_EXTENSION$1.get(entry.name.slice(dot).toLowerCase());
				if (language === void 0) continue;
				report.scanned++;
				let info;
				try {
					info = await stat(absolute);
				} catch {
					report.skipped++;
					continue;
				}
				candidates.push({
					absolute,
					path: relative(this.options.root, absolute).split(sep).join("/"),
					language,
					mtimeMs: info.mtimeMs,
					size: info.size
				});
			}
		};
		await walk(this.options.root);
		candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
		for (const candidate of candidates) {
			if (!this.index.needsUpdate(candidate.path, candidate.mtimeMs, candidate.size)) {
				report.unchanged++;
				continue;
			}
			let text;
			try {
				text = await readFile(candidate.absolute, "utf8");
			} catch {
				report.skipped++;
				continue;
			}
			const outcome = this.index.update({
				path: candidate.path,
				language: candidate.language,
				text,
				mtimeMs: candidate.mtimeMs,
				size: candidate.size
			});
			if (outcome === "indexed") report.indexed++;
			else if (outcome === "unchanged") report.unchanged++;
			else report.skipped++;
		}
		await this.index.save();
		report.chunks = this.index.status().chunks;
		report.durationMs = Date.now() - started;
		return report;
	}
	/**
	* 检索一次补全请求对应的片段，并拼成注入 prompt 的文本。
	*
	* 正文是按行范围从文件里读的：索引不存正文，所以片段永远与磁盘一致，也不会让索引把整个仓库
	* 复制一份（实测存正文时索引文件 66.9 MB）。
	*
	* 同一文件的多个命中只读一遍：先按路径归组，用一次顺序扫描把各组需要的行范围都取出来，
	* 不再为每条命中 readFile 整文件再 split。
	*/
	async retrieve(request) {
		const { line, column } = request.cursor.rewriteAt;
		const query = buildQuery(request.cursor.document, line, column);
		const hits = this.index.search(query, request.cursor.filePath);
		const texts = /* @__PURE__ */ new Map();
		const rangesByPath = /* @__PURE__ */ new Map();
		for (const hit of hits) {
			const key = snippetKey(hit);
			if (!Number.isInteger(hit.startLine) || !Number.isInteger(hit.endLine) || hit.startLine < 1 || hit.endLine < hit.startLine) {
				const body = await this.readWholeFileLines(hit.path, hit.startLine, hit.endLine);
				if (body !== void 0) texts.set(key, body);
				continue;
			}
			const ranges = rangesByPath.get(hit.path) ?? /* @__PURE__ */ new Map();
			ranges.set(`${hit.startLine}-${hit.endLine}`, {
				startLine: hit.startLine,
				endLine: hit.endLine
			});
			rangesByPath.set(hit.path, ranges);
		}
		for (const [path, ranges] of rangesByPath) {
			let bodies;
			try {
				bodies = await this.readLineRanges(join(this.options.root, path), [...ranges.values()]);
			} catch {
				continue;
			}
			for (const hit of hits) {
				if (hit.path !== path) continue;
				const body = bodies.get(`${hit.startLine}-${hit.endLine}`);
				if (body !== void 0) texts.set(snippetKey(hit), body);
			}
		}
		return formatSnippets(hits, texts, this.index.snippetChars);
	}
	/**
	* 一次顺序扫描读出若干个行范围。
	*
	* 行为对齐旧的 `text.split('\n').slice(startLine-1, endLine).join('\n')`：
	* 行文本保留 `\r`（CRLF 文件），范围外不读、读到最大 endLine 即停。
	* 文件在范围末尾之前就结束时，按 slice 的夹取语义返回实际能取到的行；
	* startLine 超过文件行数时返回空串（不是 undefined）。
	*/
	async readLineRanges(absolutePath, ranges) {
		if (ranges.length === 0) return /* @__PURE__ */ new Map();
		const buckets = /* @__PURE__ */ new Map();
		for (const range of ranges) {
			const key = `${range.startLine}-${range.endLine}`;
			if (!buckets.has(key)) buckets.set(key, { ...range });
		}
		const maxEnd = Math.max(...ranges.map((range) => range.endLine));
		const handle = await open(absolutePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(SNIPPET_READ_CHUNK_BYTES);
			let position = 0;
			let totalBytes = 0;
			let lineNumber = 1;
			let lineStartOffset = 0;
			let done = false;
			while (!done) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) break;
				totalBytes = position + bytesRead;
				let scanFrom = 0;
				while (true) {
					const newline = buffer.indexOf(10, scanFrom);
					if (newline === -1 || newline >= bytesRead) break;
					const newlineOffset = position + newline;
					for (const bucket of buckets.values()) {
						if (lineNumber === bucket.startLine) bucket.startOffset = lineStartOffset;
						if (lineNumber === bucket.endLine) bucket.endOffset = newlineOffset;
					}
					lineNumber++;
					lineStartOffset = newlineOffset + 1;
					if (lineNumber > maxEnd) {
						done = true;
						break;
					}
					scanFrom = newline + 1;
				}
				position += bytesRead;
			}
			if (!done) for (const bucket of buckets.values()) {
				if (lineNumber === bucket.startLine) bucket.startOffset = lineStartOffset;
				if (lineNumber === bucket.endLine) bucket.endOffset = totalBytes;
			}
			const result = /* @__PURE__ */ new Map();
			for (const [key, bucket] of buckets) {
				const start = bucket.startOffset;
				if (start === void 0) {
					result.set(key, "");
					continue;
				}
				const end = bucket.endOffset ?? totalBytes;
				const length = Math.max(0, end - start);
				const slice = Buffer.allocUnsafe(length);
				let filled = 0;
				while (filled < length) {
					const { bytesRead } = await handle.read(slice, filled, length - filled, start + filled);
					if (bytesRead === 0) break;
					filled += bytesRead;
				}
				result.set(key, slice.toString("utf8", 0, filled));
			}
			return result;
		} finally {
			await handle.close().catch(() => void 0);
		}
	}
	/** 旧实现：整文件读取后按行切。仅在命中缺少行号信息时使用。 */
	async readWholeFileLines(path, startLine, endLine) {
		try {
			return (await readFile(join(this.options.root, path), "utf8")).split("\n").slice(Math.max(0, startLine - 1), endLine).join("\n");
		} catch {
			return;
		}
	}
};
//#endregion
//#region src/completion/experiment.ts
/**
* 实验分组（文档 4.3 的环境元数据、文档七的「参数按实验分组灰度」）。
*
* 分组由服务端决定，客户端不固化。分配必须**按会话稳定**：同一会话的连续请求落在同一组，
* 否则一次补全用 A 组参数、下一次用 B 组，数据没法归因。
*/
const COMPLETION_EXPERIMENT_GROUPS = ["control", "treatment"];
/**
* 按会话标识稳定分组。
*
* 用 FNV-1a 而不是随机数：同一个会话必须永远得到同一组，而随机数做不到（进程重启就变）。
* 也不需要密码学强度 —— 这里只是分流，不是安全边界。
*/
function groupForSession(sessionId, groups = COMPLETION_EXPERIMENT_GROUPS) {
	const fallback = groups[0] ?? "control";
	if (groups.length <= 1) return fallback;
	let hash = 2166136261;
	for (let index = 0; index < sessionId.length; index++) {
		hash ^= sessionId.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return groups[hash % groups.length] ?? fallback;
}
/**
* 分组对应的参数。
*
* control 用文档第七节给出的起点值；treatment 只动两个最影响体感的旋钮（防抖更快、片段更多）。
* 这两个值本身未经数据验证 —— 分组机制的目的是让它们**可以被数据验证**，而不是先给出答案。
*/
function paramsForGroup(group) {
	if (group !== "treatment") return DEFAULT_COMPLETION_PARAMS;
	return {
		...DEFAULT_COMPLETION_PARAMS,
		debounceFastMs: 70,
		debounceSlowMs: 110,
		snippetCount: 6
	};
}
//#endregion
//#region src/completion/telemetry.ts
const MAX_BUCKETS = 200;
const OTHER_BUCKET = "other";
const emptyBucket = () => ({
	shown: 0,
	accepted: 0,
	cancelled: 0,
	failed: 0,
	firstByteTotal: 0,
	firstByteSamples: 0
});
function statsOf(bucket) {
	const ratio = (value) => bucket.shown === 0 ? null : value / bucket.shown;
	return {
		shown: bucket.shown,
		accepted: bucket.accepted,
		cancelled: bucket.cancelled,
		failed: bucket.failed,
		acceptanceRate: ratio(bucket.accepted),
		cancelRate: ratio(bucket.cancelled),
		averageFirstByteMs: bucket.firstByteSamples === 0 ? null : Math.round(bucket.firstByteTotal / bucket.firstByteSamples)
	};
}
/** 分桶聚合器。纯内存、无依赖，便于单测与替换。 */
var TelemetryAggregator = class {
	buckets = /* @__PURE__ */ new Map();
	/** 最近一次失败原因。诊断时要的就是它，而不是「失败过几次」。 */
	lastFailure;
	/** 记一次事件。未知的语言或分组归入 other，不丢弃 —— 事件丢掉了就再也补不回来。 */
	record(event) {
		const key = this.keyOf(event);
		let bucket = this.buckets.get(key);
		if (bucket === void 0) {
			if (this.buckets.size >= MAX_BUCKETS) bucket = this.buckets.get(OTHER_BUCKET);
			if (bucket === void 0) bucket = emptyBucket();
			this.buckets.set(key === OTHER_BUCKET || this.buckets.size < MAX_BUCKETS ? key : OTHER_BUCKET, bucket);
		}
		if (event.kind === "shown") {
			bucket.shown += 1;
			if (event.firstByteMs !== void 0 && Number.isFinite(event.firstByteMs)) {
				bucket.firstByteTotal += event.firstByteMs;
				bucket.firstByteSamples += 1;
			}
		} else if (event.kind === "accepted") bucket.accepted += 1;
		else if (event.kind === "failed") {
			bucket.failed += 1;
			if (event.error !== void 0 && event.error !== "") this.lastFailure = event.error;
		} else bucket.cancelled += 1;
	}
	/**
	* 取分桶统计。给 `language` / `experiment` 就只算匹配的那些桶。
	*
	* 汇总不是「把各桶的比率再平均」——那会让样本少的桶权重过大；这里把计数加总后再算比率。
	*/
	stats(filter = {}) {
		const total = emptyBucket();
		for (const [key, bucket] of this.buckets) {
			const [language, experiment] = key.split("\0");
			if (filter.language !== void 0 && filter.language !== language) continue;
			if (filter.experiment !== void 0 && filter.experiment !== experiment) continue;
			total.shown += bucket.shown;
			total.accepted += bucket.accepted;
			total.cancelled += bucket.cancelled;
			total.failed += bucket.failed;
			total.firstByteTotal += bucket.firstByteTotal;
			total.firstByteSamples += bucket.firstByteSamples;
		}
		return statsOf(total);
	}
	/** 每个分组的统计，按分组名排序，便于直接展示对照。 */
	byExperiment() {
		const groups = /* @__PURE__ */ new Set();
		for (const key of this.buckets.keys()) groups.add(key.split("\0")[1] ?? "");
		return [...groups].sort().map((experiment) => ({
			experiment,
			stats: this.stats({ experiment })
		}));
	}
	/** 最近一次失败原因，没有失败时为 undefined。 */
	failure() {
		return this.lastFailure;
	}
	reset() {
		this.buckets.clear();
		this.lastFailure = void 0;
	}
	keyOf(event) {
		return `${event.language === "" ? OTHER_BUCKET : event.language}\u0000${event.experiment === void 0 || event.experiment === "" ? OTHER_BUCKET : event.experiment}`;
	}
};
//#endregion
//#region src/completion/register.ts
/**
* 补全端点的注册与提供方解析。
*
* 单独成模块而不是塞进 routes.ts：这条链路有自己的提供方选择与流式收尾，放在一起会让两边都变难读。
* 复用 routes.ts 已有的 authorize / readBody / send 辅助函数，由调用方传进来，不重复实现。
*/
/**
* 选提供方。三种来源，按部署条件挑一条：
*
* - 显式要求本地兜底（`DSH_COMPLETION_PROVIDER=local`）：离线、或单独验证客户端链路时用；
* - 配了 OpenAI 兼容的补全端点（`DSH_COMPLETION_ENDPOINT`）：不依赖 DSH 账号的部署通道；
* - 其余情况用 DSH 的模型服务。模型不可用时**不会**自动回落：要回落得显式开启（见 settings.ts）。
*
* DSH 的两个服务分别探测而不是一起判：缺 `agentDefaultModel` 时仍可让配置里指定模型，
* 但缺 `llm` 就一定没有模型可用。
*/
function resolveProvider(ctx, params = DEFAULT_COMPLETION_PARAMS) {
	const llm = ctx.get("llm");
	const defaultModel = ctx.get("agentDefaultModel");
	const forced = (globalThis.process?.env?.["DSH_COMPLETION_PROVIDER"] ?? "").toLowerCase();
	const endpoint = globalThis.process?.env?.["DSH_COMPLETION_ENDPOINT"] ?? "";
	if (forced !== "local" && endpoint !== "") {
		const model = globalThis.process?.env?.["DSH_COMPLETION_MODEL"] ?? "completion";
		const apiKey = globalThis.process?.env?.["DSH_COMPLETION_API_KEY"];
		return {
			provider: httpProvider({
				baseUrl: endpoint,
				model,
				...apiKey === void 0 || apiKey === "" ? {} : { apiKey }
			}),
			profile: DEFAULT_PROMPT_PROFILE,
			source: "http",
			model
		};
	}
	if (forced !== "local" && llm !== void 0 && defaultModel !== void 0) {
		const route = completionSettings().route;
		const provider = dshProvider(llm, defaultModel, {
			params,
			...route === void 0 ? {} : { selection: route }
		});
		return {
			provider: withFallback(provider, params),
			profile: INSTRUCTION_PROMPT_PROFILE,
			source: "dsh",
			model: provider.model
		};
	}
	const provider = localProvider(params);
	return {
		provider,
		profile: DEFAULT_PROMPT_PROFILE,
		source: "local",
		model: provider.model
	};
}
/**
* 按开关决定是否给模型提供方套上本地兜底。
*
* 默认关闭：模型故障应当显式暴露，而不是悄悄降级。开启后编辑器至少还有候选可用，
* 同时每次回落都写宿主日志 —— 回落不等于把故障藏起来。
*/
function withFallback(provider, params) {
	if (!completionSettings().fallback) return provider;
	return fallbackProvider(provider, localProvider(params), { onFallback: (failure) => {
		const line = `模型调用失败，已回落本地兜底：${failure.provider}/${failure.model} · ${failure.error}`;
		console.warn(`[dsh-completion] ${line}`);
		noteCompletion(line);
	} });
}
/** 客户端从请求体里取出的必要字段；缺一不可，缺就按 400 处理。 */
function readRequest(body) {
	if (typeof body !== "object" || body === null) throw new Error("request body must be an object");
	const candidate = body;
	const cursor = candidate.cursor;
	if (cursor === void 0 || typeof cursor.document !== "string" || typeof cursor.filePath !== "string") throw new Error("cursor.document and cursor.filePath are required");
	if (typeof candidate.language !== "string" || candidate.language === "") throw new Error("language is required");
	if (cursor.rewriteAt === void 0 || typeof cursor.rewriteAt.line !== "number" || typeof cursor.rewriteAt.column !== "number") throw new Error("cursor.rewriteAt is required");
	return {
		sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : "",
		environment: candidate.environment ?? {
			ideVersion: "",
			extensionVersion: "",
			region: "",
			channel: "",
			repository: ""
		},
		language: candidate.language,
		trigger: candidate.trigger === "other" ? "other" : "inline",
		edits: Array.isArray(candidate.edits) ? candidate.edits : [],
		cursor: {
			filePath: cursor.filePath,
			rewriteAt: cursor.rewriteAt,
			document: cursor.document,
			...cursor.lastEdit === void 0 ? {} : { lastEdit: cursor.lastEdit }
		},
		diagnostics: Array.isArray(candidate.diagnostics) ? candidate.diagnostics : [],
		forceRewrite: candidate.forceRewrite === true,
		...candidate.intent === void 0 ? {} : { intent: candidate.intent },
		...candidate.security === void 0 ? {} : { security: candidate.security }
	};
}
/**
* 注册 `POST /dsh-vscode/completion`。
*
* 事件以 SSE 写出：meta → output* → done。客户端断开时中止上游 —— 这是文档 4.1 的硬要求，
* 否则用户在连续输入时会把在途连接堆起来。
*/
function registerCompletionRoute(ctx, helpers, params = DEFAULT_COMPLETION_PARAMS) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-vscode/completion",
		handler: async (req, res) => {
			if (!helpers.authorize(req, res)) return;
			if (req.method !== "POST") return helpers.send(res, 405, {
				ok: false,
				error: {
					code: "method",
					message: "POST required"
				}
			});
			let request;
			try {
				request = readRequest(await helpers.readBody(req));
			} catch (error) {
				return helpers.send(res, 400, {
					ok: false,
					error: {
						code: "bad-request",
						message: error instanceof Error ? error.message : String(error)
					}
				});
			}
			const controller = new AbortController();
			req.once("aborted", () => controller.abort());
			res.once("close", () => controller.abort());
			noteCompletion(`请求到达 session=${request.sessionId.slice(0, 20)} language=${request.language} file=${request.cursor.filePath}`);
			const experiment = groupForSession(request.sessionId);
			const tuned = {
				...request,
				environment: {
					...request.environment,
					experiment
				}
			};
			const groupParams = paramsForGroup(experiment);
			const resolved = resolveProvider(ctx, groupParams);
			const cwd = safeCwd(ctx, helpers, request.sessionId);
			const indexPromise = cwd === void 0 ? void 0 : completionIndexFor(cwd, groupParams);
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no"
			});
			try {
				res.flushHeaders();
			} catch {
				return;
			}
			let index;
			if (indexPromise !== void 0) try {
				index = await indexPromise;
			} catch (error) {
				noteCompletion(`索引不可用，按无检索上下文继续：${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				let candidateCount = 0;
				let firstByteMs;
				for await (const event of runCompletion(tuned, {
					provider: resolved.provider,
					params: groupParams,
					profile: resolved.profile,
					signal: controller.signal,
					...index === void 0 ? {} : { retrieve: (current) => index.retrieve(current) },
					...cwd === void 0 ? {} : { onSecurityHit: (hit, current) => {
						appendSecurityAudit(cwd, hit, current);
					} }
				})) {
					if (event.type === "output") for (const candidate of event.candidates) {
						candidateCount = Math.max(candidateCount, candidate.index + 1);
						firstByteMs ??= candidate.elapsedMs;
					}
					if (res.writableEnded) break;
					res.write(encodeSseEvent(event));
				}
				if (candidateCount > 0) {
					noteCompletion(`产出候选 ${candidateCount} 条，首字节 ${firstByteMs ?? -1} ms，模型=${resolved.model}`);
					completionTelemetry.record({
						kind: "shown",
						sessionId: request.sessionId,
						language: request.language,
						model: resolved.model,
						experiment,
						...firstByteMs === void 0 ? {} : { firstByteMs },
						candidateCount
					});
				}
			} catch (error) {
				noteCompletion(`失败 ${error instanceof Error ? error.message : String(error)}`);
				const failure = {
					type: "error",
					code: "completion-failed",
					message: error instanceof Error ? error.message : String(error)
				};
				if (!res.writableEnded) res.write(encodeSseEvent(failure));
			} finally {
				if (!res.writableEnded) res.end();
			}
		}
	}), "dsh-aide: inline completion");
}
/** 补全埋点聚合器（文档七：采纳率为主指标）。进程内保存，重启即清零。 */
const completionTelemetry = new TelemetryAggregator();
/**
* 内容安全审计（文档 6.4：拦截与脱敏两种动作都要写入审计日志）。
*
* 写在索引同一个工作区目录下（那里已经被索引自带的 .gitignore 排除），一行一条，便于事后追查。
* 落盘失败不影响补全：审计是旁路，不能因为它把补全拖垮。
*/
function appendSecurityAudit(cwd, hit, request) {
	const line = JSON.stringify({
		at: (/* @__PURE__ */ new Date()).toISOString(),
		action: hit.action,
		ruleId: hit.ruleId,
		ruleName: hit.ruleName,
		sessionId: request.sessionId,
		filePath: request.cursor.filePath,
		language: request.language
	}) + "\n";
	appendFile(path.join(cwd, ".dsh-workbench", "audit.jsonl"), line, "utf8").catch(() => void 0);
}
/** 每个工作区一份索引，进程内复用；索引文件本身由 WorkspaceIndex 落到工作区里。 */
const indexes = /* @__PURE__ */ new Map();
function completionIndexFor(cwd, params = DEFAULT_COMPLETION_PARAMS) {
	const existing = indexes.get(cwd);
	if (existing !== void 0) return existing;
	let created;
	created = WorkspaceIndex.open({
		root: cwd,
		params
	}).then((index) => {
		index.ensureFresh()?.catch(() => void 0);
		return index;
	}).catch((error) => {
		if (indexes.get(cwd) === created) indexes.delete(cwd);
		throw error;
	});
	indexes.set(cwd, created);
	return created;
}
/**
* 解析这次补全该在哪个工作区里检索。
*
* 优先用请求里的会话；会话号对不上（例如接口探针传的是占位值）时退到任一已知会话的工作区；
* 都拿不到就返回 undefined，由调用方跳过检索。**不能退到进程目录**：桌面端进程的工作目录是
* 应用自己的目录，索引它既白扫一遍，又会让检索永远命中无关内容。
*/
function safeCwd(ctx, helpers, sessionId) {
	const sessions = ctx.get("sessions");
	const own = sessions?.get(sessionId)?.header?.cwd;
	if (own !== void 0 && own !== "") try {
		return helpers.cwdFor(sessionId);
	} catch {
		return normalize(own);
	}
	for (const session of sessions?.list() ?? []) {
		const cwd = session?.header?.cwd;
		if (cwd !== void 0 && cwd !== "") return normalize(cwd);
	}
}
//#endregion
//#region src/language/protocol.ts
/** 扩展名 → Monaco 语言 id。只列 AIDE 需要区分的语言；没有映射的返回 undefined。 */
const LANGUAGE_BY_EXTENSION = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	jsonc: "json",
	py: "python",
	pyi: "python",
	rs: "rust",
	go: "go",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	yaml: "yaml",
	yml: "yaml",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	lua: "lua",
	php: "php",
	rb: "ruby",
	java: "java",
	kt: "kotlin",
	cs: "csharp",
	swift: "swift",
	sql: "sql"
};
/** 文件名 → 语言 id（Makefile、Dockerfile 这类没有扩展名但有固定名字的文件）。 */
const LANGUAGE_BY_NAME = {
	dockerfile: "dockerfile",
	makefile: "makefile"
};
/** 取路径的语言 id；大小写不敏感，取最后一段扩展名。 */
function languageIdForPath(path) {
	const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
	const byName = LANGUAGE_BY_NAME[name];
	if (byName !== void 0) return byName;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return void 0;
	return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)];
}
/** 是否属于内置 TypeScript 服务负责的语言。 */
function isTypeScriptLanguage(languageId) {
	return languageId === "typescript" || languageId === "javascript" || languageId === "javascriptreact" || languageId === "typescriptreact";
}
/** 统计一组诊断的严重级别数量。 */
function diagnosticCounts(diagnostics) {
	let errors = 0, warnings = 0, infos = 0, hints = 0;
	for (const diagnostic of diagnostics) if (diagnostic.severity === "error") errors++;
	else if (diagnostic.severity === "warning") warnings++;
	else if (diagnostic.severity === "info") infos++;
	else hints++;
	return {
		errors,
		warnings,
		infos,
		hints
	};
}
/** 诊断严重级别排序权重（越小越靠前）。 */
function severityRank$1(severity) {
	switch (severity) {
		case "error": return 0;
		case "warning": return 1;
		case "info": return 2;
		case "hint": return 3;
	}
}
/** 清空语言服务状态时用的固定标识，避免客户端各处重复拼字符串。 */
const BUILTIN_TYPESCRIPT_ID = "builtin-typescript";
//#endregion
//#region src/language/servers.ts
/**
* 外部语言服务器目录与可执行文件发现。
*
* 这里不启动进程，只回答三个问题：本机装了哪些服务器、某个语言该用哪个、用户配置里的服务器
* 长什么样。真正的启动在 `lsp/external.ts`，这样「发现」可以在没有工作区、没有语言服务管理器的
* 情况下单测。
*/
/** 内置目录：覆盖 AIDE 打出诊断/跳转承诺的语言。顺序不重要（按语言匹配）。 */
const KNOWN_SERVERS = [
	{
		id: "python",
		name: "Python (Pyright / Pylsp)",
		languages: ["python"],
		extensions: [
			"py",
			"pyi",
			"pyw"
		],
		command: "pyright-langserver",
		args: ["--stdio"],
		commandCandidates: [{ command: "pylsp" }]
	},
	{
		id: "rust",
		name: "Rust (rust-analyzer)",
		languages: ["rust"],
		extensions: ["rs"],
		command: "rust-analyzer",
		args: []
	},
	{
		id: "go",
		name: "Go (gopls)",
		languages: ["go"],
		extensions: ["go"],
		command: "gopls",
		args: []
	},
	{
		id: "c",
		name: "C/C++ (clangd)",
		languages: ["c", "cpp"],
		extensions: [
			"c",
			"h",
			"cc",
			"cpp",
			"cxx",
			"hpp",
			"hh",
			"hxx"
		],
		command: "clangd",
		args: []
	},
	{
		id: "yaml",
		name: "YAML",
		languages: ["yaml"],
		extensions: ["yaml", "yml"],
		command: "yaml-language-server",
		args: ["--stdio"]
	},
	{
		id: "shellscript",
		name: "Shell (bash-language-server)",
		languages: ["shellscript"],
		extensions: [
			"sh",
			"bash",
			"zsh"
		],
		command: "bash-language-server",
		args: ["start"]
	},
	{
		id: "lua",
		name: "Lua",
		languages: ["lua"],
		extensions: ["lua"],
		command: "lua-language-server",
		args: []
	},
	{
		id: "php",
		name: "PHP (Intelephense)",
		languages: ["php"],
		extensions: ["php"],
		command: "intelephense",
		args: ["--stdio"]
	},
	{
		id: "ruby",
		name: "Ruby (Solargraph)",
		languages: ["ruby"],
		extensions: ["rb"],
		command: "solargraph",
		args: ["stdio"]
	},
	{
		id: "dockerfile",
		name: "Dockerfile",
		languages: ["dockerfile"],
		extensions: [],
		command: "docker-langserver",
		args: ["--stdio"]
	},
	{
		id: "makefile",
		name: "Makefile",
		languages: ["makefile"],
		extensions: ["mk"],
		command: "make-language-server",
		args: []
	}
];
const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_PATH_SEPARATOR = ";";
const POSIX_PATH_SEPARATOR = ":";
function isRecord$3(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** 大小写不敏感地读环境变量：Windows 上 PATH/Path/PATHEXT/PathExt 的写法不统一。 */
function envValue(env, name) {
	const target = name.toLowerCase();
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() !== target) continue;
		const value = env[key];
		return typeof value === "string" ? value : void 0;
	}
}
function isUsableFile(path, platform) {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** 给一个不带扩展名的路径补出 Windows 的 PATHEXT 候选（POSIX 上原样一个候选）。 */
function executableCandidates(base, platform, env) {
	if (platform !== "win32") return [base];
	const extensions = (envValue(env, "PATHEXT") ?? WINDOWS_PATHEXT).split(";").map((value) => value.trim()).filter((value) => value !== "");
	const lower = base.toLowerCase();
	const candidates = [base];
	for (const extension of extensions) if (!lower.endsWith(extension.toLowerCase())) candidates.push(base + extension);
	return candidates;
}
function firstUsable(candidates, platform) {
	return candidates.find((candidate) => isUsableFile(candidate, platform));
}
/**
* 在 PATH（或给定的绝对/相对路径）上定位可执行文件。
*
* - 绝对路径与带分隔符的相对路径直接检查，不再走 PATH；
* - 裸名字按 PATH 目录逐个尝试，Windows 再按 PATHEXT 补 `.exe/.cmd/...`；
* - 找不到返回 undefined（调用方据此把服务器标成 missing）。
*/
function resolveExecutable(command, env = process.env, platform = process.platform) {
	const trimmed = command.trim();
	if (trimmed === "") return void 0;
	const hasSeparator = trimmed.includes("/") || trimmed.includes("\\");
	if (isAbsolute(trimmed) || platform === "win32" && /^[a-zA-Z]:[\\/]/.test(trimmed)) return firstUsable(executableCandidates(trimmed, platform, env), platform);
	if (hasSeparator) return firstUsable(executableCandidates(resolve(trimmed), platform, env), platform);
	const pathValue = envValue(env, "PATH");
	if (pathValue === void 0) return void 0;
	const separator = platform === "win32" ? WINDOWS_PATH_SEPARATOR : POSIX_PATH_SEPARATOR;
	for (const directory of pathValue.split(separator)) {
		if (directory.trim() === "") continue;
		const found = firstUsable(executableCandidates(join(directory, trimmed), platform, env), platform);
		if (found !== void 0) return found;
	}
}
function stringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "");
}
function optionalStringRecord(value) {
	if (!isRecord$3(value)) return void 0;
	const result = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string" && key.trim() !== "") result[key] = item;
	return Object.keys(result).length === 0 ? void 0 : result;
}
/** 扩展名归一：去掉前导点、转小写。 */
function normalizeExtensions(value) {
	return stringArray(value).map((item) => item.replace(/^\.+/, "").toLowerCase()).filter((item) => item !== "");
}
/** 只有扩展名没有语言 id 时，用公共协议里的扩展名映射反推语言 id。 */
function languagesFromExtensions(extensions) {
	const languages = [];
	for (const extension of extensions) {
		const languageId = languageIdForPath(`file.${extension}`);
		if (languageId !== void 0 && !languages.includes(languageId)) languages.push(languageId);
	}
	return languages;
}
function parseCommandCandidates(value) {
	if (!Array.isArray(value)) return [];
	const candidates = [];
	for (const item of value) {
		if (!isRecord$3(item)) continue;
		const command = typeof item.command === "string" ? item.command.trim() : "";
		if (command === "") continue;
		candidates.push({
			command,
			args: stringArray(item.args)
		});
	}
	return candidates;
}
function parseServerDefinition(item) {
	if (!isRecord$3(item)) return void 0;
	const command = typeof item.command === "string" ? item.command.trim() : "";
	if (command === "") return void 0;
	const extensions = normalizeExtensions(item.extensions);
	const languages = stringArray(item.languages).map((language) => language.toLowerCase());
	for (const language of languagesFromExtensions(extensions)) if (!languages.includes(language)) languages.push(language);
	const commandCandidates = parseCommandCandidates(item.commandCandidates);
	const env = optionalStringRecord(item.env);
	const id = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `custom-${command.split(/[\\/]/).at(-1) ?? command}`;
	return {
		id,
		name: typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id,
		languages,
		extensions,
		command,
		args: stringArray(item.args),
		...commandCandidates.length === 0 ? {} : { commandCandidates },
		...env === void 0 ? {} : { env },
		...item.initializationOptions === void 0 ? {} : { initializationOptions: item.initializationOptions }
	};
}
/** 从配置里取出服务器条目数组：支持 `{ language: { servers: [...] } }`、`{ servers: [...] }` 与裸数组。 */
function configuredItems(config) {
	if (Array.isArray(config)) return config;
	if (!isRecord$3(config)) return [];
	if (Array.isArray(config.servers)) return config.servers;
	const language = config.language;
	if (isRecord$3(language) && Array.isArray(language.servers)) return language.servers;
	return [];
}
/**
* 解析插件配置里的自定义服务器。
*
* 宽松：坏项（没有 command、不是对象、id 重复）直接跳过而不是整份配置作废 —— 用户手写 JSON
* 很容易有笔误，一个坏项不该让其它能用的服务器全部失效。
*/
function parseConfiguredServers(config) {
	const definitions = [];
	const ids = /* @__PURE__ */ new Set();
	for (const item of configuredItems(config)) {
		const definition = parseServerDefinition(item);
		if (definition === void 0 || ids.has(definition.id)) continue;
		ids.add(definition.id);
		definitions.push(definition);
	}
	return definitions;
}
/** 一组候选：首选命令 + 备选命令。 */
function commandChoices(definition) {
	return [{
		command: definition.command,
		args: definition.args
	}, ...definition.commandCandidates ?? []];
}
/**
* 探测本机可用的外部服务器。
*
* 顺序是「自定义 → 内置」，且自定义与内置同 id 时自定义覆盖内置（同一个 id 就是同一个服务器，
* 用户配置里的 command 应当优先）；`serverForLanguage` 按这个顺序取第一个匹配。
*/
function discoverServers(env = process.env, config) {
	const definitions = [];
	const seen = /* @__PURE__ */ new Set();
	for (const definition of [...parseConfiguredServers(config), ...KNOWN_SERVERS]) {
		if (seen.has(definition.id)) continue;
		seen.add(definition.id);
		definitions.push(definition);
	}
	const available = [];
	const missing = [];
	for (const definition of definitions) {
		const choice = commandChoices(definition).map((candidate) => ({
			candidate,
			executable: resolveExecutable(candidate.command, env)
		})).find((item) => item.executable !== void 0);
		if (choice === void 0 || choice.executable === void 0) {
			missing.push(definition);
			continue;
		}
		available.push({
			id: definition.id,
			name: definition.name,
			languages: definition.languages,
			extensions: definition.extensions,
			executable: choice.executable,
			args: choice.candidate.args ?? [],
			definition
		});
	}
	return {
		available,
		missing
	};
}
/** 按语言 id 选服务器：调用方按优先级排好序（discoverServers 的 available 即自定义优先）。 */
function serverForLanguage(languageId, servers) {
	const target = languageId.trim().toLowerCase();
	return servers.find((server) => server.definition.languages.some((language) => language.toLowerCase() === target));
}
//#endregion
//#region src/language/lsp/client.ts
/**
* 最小可用的 LSP JSON-RPC 客户端。
*
* 职责边界：
*   - 管 JSON-RPC 的 id/超时/取消/服务端主动请求，以及 initialize 握手；
*   - 把 `textDocument/publishDiagnostics` 的 file URI 转成绝对路径、转成公共协议的诊断类型；
*   - 不问「哪个文档该开」，也不做能力到 provider 方法的映射 —— 那是 external.ts。
*
* 未知/错误一律记日志不抛：语言服务器是外部进程，协议噪声不能把宿主带崩；只有真正等结果的
* `request()` 会 reject，由调用方决定降级（external.ts 选择返回空结果）。
*/
const DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
const SHUTDOWN_TIMEOUT_MS = 2e3;
/** 文件系统路径 → file URI。 */
function pathToUri(path) {
	return pathToFileURL(path).href;
}
/** file URI → 文件系统路径；非 file URI（untitled: 等）返回 undefined。 */
function uriToPath(uri) {
	try {
		return fileURLToPath(uri);
	} catch {
		return;
	}
}
/**
* 客户端声明的能力。
*
* snippetSupport 明确为 false：Monaco 这边没有实现 snippet 占位符跳转，声明 true 只会让服务器
* 发来 `$1` 这类文本插进编辑器；其余能力与 external.ts 实际实现的 provider 方法一一对应。
*/
const CLIENT_CAPABILITIES = {
	workspace: {
		configuration: true,
		workspaceFolders: true
	},
	textDocument: {
		synchronization: {
			dynamicRegistration: false,
			didSave: false,
			willSave: false
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] }
		},
		hover: { contentFormat: ["markdown", "plaintext"] },
		definition: { linkSupport: true },
		references: {},
		rename: { prepareSupport: false },
		documentSymbol: { hierarchicalDocumentSymbolSupport: true },
		workspaceSymbol: {},
		completion: { completionItem: {
			snippetSupport: false,
			documentationFormat: ["markdown", "plaintext"]
		} },
		signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
		codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [
			"",
			"quickfix",
			"refactor",
			"refactor.extract",
			"refactor.inline",
			"refactor.rewrite",
			"source",
			"source.organizeImports",
			"source.fixAll"
		] } } }
	}
};
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function messageOf$2(error) {
	return error instanceof Error ? error.message : String(error);
}
function numberValue$2(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
function wirePosition(value) {
	const record = isRecord$2(value) ? value : {};
	return {
		line: numberValue$2(record.line),
		character: numberValue$2(record.character)
	};
}
function wireRange(value) {
	const record = isRecord$2(value) ? value : {};
	return {
		start: wirePosition(record.start),
		end: wirePosition(record.end)
	};
}
/** LSP DiagnosticSeverity 数字 → 公共协议字符串；缺省按 warning（服务器没给级别时不要假装是错误）。 */
function severityOf$2(value) {
	switch (value) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "warning";
	}
}
function tagsOf$2(value) {
	if (!Array.isArray(value)) return void 0;
	const tags = [];
	for (const item of value) if (item === 1 && !tags.includes("unnecessary")) tags.push("unnecessary");
	else if (item === 2 && !tags.includes("deprecated")) tags.push("deprecated");
	return tags.length === 0 ? void 0 : tags;
}
function relatedOf(value) {
	if (!Array.isArray(value)) return void 0;
	const related = [];
	for (const item of value) {
		if (!isRecord$2(item) || !isRecord$2(item.location) || typeof item.location.uri !== "string") continue;
		const path = uriToPath(item.location.uri);
		if (path === void 0) continue;
		related.push({
			path,
			range: wireRange(item.location.range),
			message: typeof item.message === "string" ? item.message : ""
		});
	}
	return related.length === 0 ? void 0 : related;
}
function diagnosticOf(value) {
	if (!isRecord$2(value) || !isRecord$2(value.range)) return void 0;
	const diagnostic = {
		range: wireRange(value.range),
		severity: severityOf$2(value.severity),
		message: typeof value.message === "string" ? value.message : ""
	};
	if (typeof value.code === "number") diagnostic.code = String(value.code);
	else if (typeof value.code === "string") diagnostic.code = value.code;
	if (typeof value.source === "string") diagnostic.source = value.source;
	const tags = tagsOf$2(value.tags);
	if (tags !== void 0) diagnostic.tags = tags;
	const related = relatedOf(value.relatedInformation);
	if (related !== void 0) diagnostic.related = related;
	return diagnostic;
}
var LspClient = class {
	options;
	nextId = 1;
	pending = /* @__PURE__ */ new Map();
	notificationHandlers = /* @__PURE__ */ new Map();
	requestHandlers = /* @__PURE__ */ new Map();
	subscriptions = [];
	startPromise;
	stopPromise;
	serverCapabilitiesValue = {};
	started = false;
	closed = false;
	stopped = false;
	constructor(options) {
		this.options = options;
		this.subscriptions.push(options.transport.onMessage((message) => this.dispatch(message)));
		this.subscriptions.push(options.transport.onClose((error) => this.handleClose(error)));
		this.requestHandlers.set("workspace/configuration", () => []);
		this.requestHandlers.set("client/registerCapability", () => null);
		this.requestHandlers.set("window/workDoneProgress/create", () => null);
		this.onNotification("window/showMessage", (params) => {
			if (!isRecord$2(params) || typeof params.message !== "string") return;
			const level = params.type === 1 ? "error" : params.type === 2 ? "warn" : "info";
			this.log(level, params.message);
		});
		this.onNotification("window/logMessage", (params) => {
			if (isRecord$2(params) && typeof params.message === "string") this.log(params.type === 1 ? "error" : "info", params.message);
		});
		this.onNotification("textDocument/publishDiagnostics", (params) => this.handleDiagnostics(params));
	}
	/** 服务器在 initialize 响应里声明的能力（未初始化时为空对象）。 */
	get capabilities() {
		return this.serverCapabilitiesValue;
	}
	get isClosed() {
		return this.closed;
	}
	/**
	* 发 initialize 并等响应，然后发 initialized。
	*
	* 幂等：重复调用共享同一次握手（external.ts 的懒启动可能被并发的 open/change 同时触发）。
	* 超时/错误会 reject，但不会自动重试 —— 重试 spawn 外部进程的代价与副作用都太大，交给上层决定。
	*/
	start(options = {}) {
		if (this.startPromise === void 0) this.startPromise = this.initialize(options);
		return this.startPromise;
	}
	async initialize(options) {
		const workspace = this.options.workspace;
		const rootUri = pathToFileURL(workspace).href;
		const result = await this.request("initialize", {
			processId: process.pid,
			clientInfo: { name: this.options.clientName ?? "dsh-aide" },
			rootUri,
			workspaceFolders: [{
				uri: rootUri,
				name: basename(workspace)
			}],
			capabilities: CLIENT_CAPABILITIES,
			...options.initializationOptions === void 0 ? {} : { initializationOptions: options.initializationOptions },
			trace: "off"
		});
		if (isRecord$2(result) && isRecord$2(result.capabilities)) this.serverCapabilitiesValue = result.capabilities;
		this.notify("initialized", {});
		this.started = true;
	}
	/**
	* 发一个请求并等响应。
	*
	* `signal` 触发时发 `$/cancelRequest`（让服务器别再算）并立刻 reject；超时同理。两者都只
	* reject 本地 Promise，不关闭连接。
	*/
	request(method, params, signal, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) {
		if (this.stopped || this.closed) return Promise.reject(/* @__PURE__ */ new Error("LSP connection is not available"));
		if (signal?.aborted === true) return Promise.reject(/* @__PURE__ */ new Error(`LSP request cancelled: ${method}`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.settle(id);
				reject(/* @__PURE__ */ new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);
			timer.unref?.();
			const onAbort = () => {
				if (!this.pending.has(id)) return;
				this.settle(id);
				this.notify("$/cancelRequest", { id });
				reject(/* @__PURE__ */ new Error(`LSP request cancelled: ${method}`));
			};
			this.pending.set(id, {
				method,
				resolve: (value) => resolve(value),
				reject,
				timer,
				signal,
				onAbort
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.sendMessage({
				jsonrpc: "2.0",
				id,
				method,
				params
			});
		});
	}
	/** 发一条通知（无响应）。 */
	notify(method, params) {
		if (this.stopped || this.closed) return;
		this.sendMessage({
			jsonrpc: "2.0",
			method,
			...params === void 0 ? {} : { params }
		});
	}
	/** 注册服务端通知处理器；返回取消注册函数。 */
	onNotification(method, handler) {
		const handlers = this.notificationHandlers.get(method) ?? /* @__PURE__ */ new Set();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => {
			handlers.delete(handler);
		};
	}
	/** 注册服务端请求处理器；返回取消注册函数。 */
	onRequest(method, handler) {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}
	didOpen(document) {
		this.notify("textDocument/didOpen", { textDocument: {
			uri: pathToUri(document.path),
			languageId: document.languageId,
			version: document.version,
			text: document.content
		} });
	}
	/** 全量同步：只发整篇正文（CLIENT_CAPABILITIES 里没有声明增量同步）。 */
	didChange(document) {
		this.notify("textDocument/didChange", {
			textDocument: {
				uri: pathToUri(document.path),
				version: document.version
			},
			contentChanges: [{ text: document.content }]
		});
	}
	didClose(path) {
		this.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
	}
	/**
	* 优雅退出：shutdown 请求（最多 2s）→ exit 通知 → 关传输层。
	*
	* 即使 shutdown 卡住/失败也继续发 exit 并关连接 —— 不能让一个不听话的服务器拖住宿主退出。
	*/
	stop() {
		if (this.stopPromise === void 0) this.stopPromise = this.shutdown();
		return this.stopPromise;
	}
	async shutdown() {
		try {
			if (this.started && !this.closed) {
				await this.request("shutdown", void 0, void 0, SHUTDOWN_TIMEOUT_MS).catch(() => void 0);
				this.sendMessage({
					jsonrpc: "2.0",
					method: "exit"
				});
			}
		} finally {
			this.stopped = true;
			this.rejectPending(/* @__PURE__ */ new Error("LSP client stopped"));
			for (const dispose of this.subscriptions.splice(0)) dispose();
			this.options.transport.close();
		}
	}
	dispatch(message) {
		if (!isRecord$2(message)) {
			this.log("warn", "language server sent a non-object message");
			return;
		}
		if (typeof message.method === "string") {
			if (typeof message.id === "number" || typeof message.id === "string") this.handleServerRequest(message.id, message.method, message.params);
			else this.handleServerNotification(message.method, message.params);
			return;
		}
		if (message.id === void 0 || message.id === null) return;
		this.handleResponse(message);
	}
	handleResponse(message) {
		if (typeof message.id !== "number") {
			this.log("warn", `language server sent a response with unexpected id: ${String(message.id)}`);
			return;
		}
		const entry = this.settle(message.id);
		if (entry === void 0) {
			this.log("warn", `language server sent a response for unknown request ${message.id}`);
			return;
		}
		if (isRecord$2(message.error)) {
			const code = typeof message.error.code === "number" ? ` (${message.error.code})` : "";
			const text = typeof message.error.message === "string" ? message.error.message : "unknown error";
			entry.reject(/* @__PURE__ */ new Error(`LSP ${entry.method} failed${code}: ${text}`));
			return;
		}
		entry.resolve(message.result);
	}
	async handleServerRequest(id, method, params) {
		const handler = this.requestHandlers.get(method);
		if (handler === void 0) {
			this.log("warn", `unsupported language server request: ${method}`);
			this.sendMessage({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32601,
					message: `method not supported: ${method}`
				}
			});
			return;
		}
		try {
			const result = await handler(params);
			if (this.closed) return;
			this.sendMessage({
				jsonrpc: "2.0",
				id,
				result: result ?? null
			});
		} catch (error) {
			if (this.closed) return;
			this.sendMessage({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: messageOf$2(error)
				}
			});
		}
	}
	handleServerNotification(method, params) {
		const handlers = this.notificationHandlers.get(method);
		if (handlers === void 0) return;
		for (const handler of [...handlers]) try {
			handler(params);
		} catch (error) {
			this.log("warn", `language server notification ${method} failed: ${messageOf$2(error)}`);
		}
	}
	handleDiagnostics(params) {
		if (!isRecord$2(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) {
			this.log("warn", "language server sent malformed publishDiagnostics");
			return;
		}
		const path = uriToPath(params.uri);
		if (path === void 0) return;
		const diagnostics = params.diagnostics.map(diagnosticOf).filter((value) => value !== void 0);
		this.options.onDiagnostics?.(path, diagnostics);
	}
	handleClose(error) {
		if (this.closed) return;
		this.closed = true;
		this.rejectPending(error ?? /* @__PURE__ */ new Error("LSP connection closed"));
		if (error !== void 0) this.log("warn", `language server connection closed: ${error.message}`);
	}
	rejectPending(error) {
		const ids = [...this.pending.keys()];
		for (const id of ids) this.settle(id)?.reject(error);
	}
	settle(id) {
		const entry = this.pending.get(id);
		if (entry === void 0) return void 0;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.signal?.removeEventListener("abort", entry.onAbort);
		return entry;
	}
	sendMessage(message) {
		try {
			this.options.transport.send(message);
		} catch (error) {
			this.log("warn", `failed to send LSP message: ${messageOf$2(error)}`);
		}
	}
	log(level, message) {
		try {
			this.options.onLog?.(level, message);
		} catch {}
	}
};
//#endregion
//#region src/language/lsp/transport.ts
/**
* LSP 的 stdio 传输层：帧编解码、子进程启动与生命周期。
*
* 这里只做两件事：把字节流切成 JSON 消息、把 JSON 消息写回字节流；协议语义（initialize、
* 请求超时、诊断转换）在 client.ts。拆开的好处是「半包 / 粘包 / 坏头」能脱离真实服务器单测。
*/
/** 单条消息上限：坏头里一个巨大的 Content-Length 不能让我们按它预分配内存。 */
const MAX_MESSAGE_BYTES = 33554432;
const CRLF_HEADER_END = Buffer.from("\r\n\r\n", "ascii");
const LF_HEADER_END = Buffer.from("\n\n", "ascii");
/** close() 之后等这么久还没退出就强杀：有些服务器收到 EOF 也不自己退。 */
const CLOSE_TIMEOUT_MS = 1e3;
/**
* 编码一条 LSP 帧：`Content-Length: N\r\n\r\n` + UTF-8 JSON。
*
* Content-Length 必须是 **UTF-8 字节数**，不是字符串长度 —— 服务器会按字节数切下一帧，
* 中文/emoji 用 `text.length` 会少算，导致服务器一直等不到完整正文。
*/
function encodeLspMessage(message) {
	const json = JSON.stringify(message);
	if (json === void 0) throw new Error("cannot encode a non-serializable LSP message");
	const body = Buffer.from(json, "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
/** 找头部结束位置。LSP 规定 CRLF，但部分服务器用裸 `\n`，两种都接受。 */
function headerBounds(buffer) {
	const crlf = buffer.indexOf(CRLF_HEADER_END);
	const lf = buffer.indexOf(LF_HEADER_END);
	if (crlf === -1 && lf === -1) return void 0;
	if (crlf !== -1 && (lf === -1 || crlf <= lf)) return {
		headerEnd: crlf,
		bodyStart: crlf + CRLF_HEADER_END.length
	};
	return {
		headerEnd: lf,
		bodyStart: lf + LF_HEADER_END.length
	};
}
/** 解析头部里的 Content-Length；头部非法、缺失或超限都抛错（调用方据此断开连接）。 */
function contentLength(headerText) {
	let length;
	for (const rawLine of headerText.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon <= 0) throw new Error(`malformed LSP header line: ${line}`);
		if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
		const value = line.slice(colon + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error(`invalid LSP Content-Length: ${value}`);
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed > MAX_MESSAGE_BYTES) throw new Error(`LSP Content-Length is too large: ${value}`);
		length = parsed;
	}
	if (length === void 0) throw new Error("LSP header is missing Content-Length");
	return length;
}
/**
* 字节流 → 消息的增量解析器。
*
* stdout 分块是任意的：一帧可能拆成几块（半包），一块里也可能有多帧（粘包），所以必须
* 缓存未消费的字节、按 Content-Length 精确切分。按 Buffer 而不是字符串缓存，才能在
* 正文里出现被 chunk 边界切断的多字节 UTF-8 字符时仍然正确。
*/
var LspStreamParser = class {
	buffer = Buffer.alloc(0);
	/** 追加一块数据，返回这次凑齐的完整消息（可能 0 条、1 条或多条）。 */
	push(chunk) {
		if (chunk.length > 0) this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const messages = [];
		for (;;) {
			const bounds = headerBounds(this.buffer);
			if (bounds === void 0) break;
			const length = contentLength(this.buffer.subarray(0, bounds.headerEnd).toString("ascii"));
			if (this.buffer.length - bounds.bodyStart < length) break;
			const body = this.buffer.subarray(bounds.bodyStart, bounds.bodyStart + length);
			this.buffer = this.buffer.subarray(bounds.bodyStart + length);
			try {
				messages.push(JSON.parse(body.toString("utf8")));
			} catch {
				throw new Error("LSP message body is not valid JSON");
			}
		}
		if (messages.length > 0 && this.buffer.length > 0) this.buffer = Buffer.from(this.buffer);
		return messages;
	}
	/** 还没凑成完整一帧的字节数（排查用）。 */
	get pendingBytes() {
		return this.buffer.length;
	}
};
/** 在当前进程环境里读一个变量（Windows 的 PATH/PATHEXT 大小写不定）。 */
function readEnv(env, name) {
	const target = name.toLowerCase();
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() !== target) continue;
		const value = env[key];
		return typeof value === "string" ? value : void 0;
	}
}
/** 合并环境变量：option.env 覆盖 process.env；同名的不同大小写键只保留一份。 */
function mergedEnv(extra) {
	if (extra === void 0) return process.env;
	const merged = { ...process.env };
	for (const [key, value] of Object.entries(extra)) {
		if (value === void 0) continue;
		for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
		merged[key] = value;
	}
	return merged;
}
function spawnChild(options) {
	const env = mergedEnv(options.env);
	const args = [...options.args ?? []];
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(options.command)) {
		const comspec = readEnv(env, "COMSPEC") ?? "cmd.exe";
		return spawn(comspec, [
			"/d",
			"/s",
			"/c",
			options.command,
			...args
		], {
			cwd: options.cwd,
			env,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
	}
	return spawn(options.command, args, {
		cwd: options.cwd,
		env,
		windowsHide: true,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		]
	});
}
var ChildProcessTransport = class {
	options;
	child;
	parser = new LspStreamParser();
	messageListeners = /* @__PURE__ */ new Set();
	closeListeners = /* @__PURE__ */ new Set();
	stderrBuffer = "";
	closed = false;
	closing = false;
	closeTimer;
	constructor(options) {
		this.options = options;
		this.child = spawnChild(options);
		this.child.stdout?.on("data", (chunk) => this.consumeStdout(chunk));
		this.child.stderr?.on("data", (chunk) => this.consumeStderr(chunk));
		this.child.stdin?.on("error", (error) => this.finish(error));
		this.child.on("error", (error) => this.finish(error));
		this.child.on("close", (code, signal) => {
			const failed = !this.closing && code !== 0;
			const detail = signal === null || signal === void 0 ? `code ${code ?? "null"}` : `code ${code ?? "null"}, signal ${signal}`;
			this.finish(failed ? /* @__PURE__ */ new Error(`LSP server exited with ${detail}`) : void 0);
		});
	}
	send(message) {
		if (this.closed || this.closing) return;
		let frame;
		try {
			frame = encodeLspMessage(message);
		} catch (error) {
			this.finish(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		try {
			this.child.stdin?.write(frame, (error) => {
				if (error !== void 0 && error !== null) this.finish(error);
			});
		} catch (error) {
			this.finish(error instanceof Error ? error : new Error(String(error)));
		}
	}
	onMessage(listener) {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}
	onClose(listener) {
		if (this.closed) {
			listener();
			return () => void 0;
		}
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}
	close() {
		if (this.closed || this.closing) return;
		this.closing = true;
		try {
			this.child.stdin?.end();
		} catch {}
		this.closeTimer = setTimeout(() => {
			this.closeTimer = void 0;
			try {
				this.child.kill("SIGKILL");
			} catch {}
		}, CLOSE_TIMEOUT_MS);
		this.closeTimer.unref?.();
	}
	consumeStdout(chunk) {
		let messages;
		try {
			messages = this.parser.push(chunk);
		} catch (error) {
			this.finish(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		for (const message of messages) for (const listener of this.messageListeners) try {
			listener(message);
		} catch {}
	}
	consumeStderr(chunk) {
		this.stderrBuffer += chunk.toString("utf8");
		const lines = this.stderrBuffer.split("\n");
		this.stderrBuffer = lines.pop() ?? "";
		for (const line of lines) this.emitStderr(line);
	}
	flushStderr() {
		const tail = this.stderrBuffer;
		this.stderrBuffer = "";
		if (tail !== "") this.emitStderr(tail);
	}
	emitStderr(line) {
		const text = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (text.trim() === "") return;
		try {
			this.options.onStderr?.(text);
		} catch {}
	}
	finish(error) {
		if (this.closed) return;
		this.closed = true;
		if (this.closeTimer !== void 0) {
			clearTimeout(this.closeTimer);
			this.closeTimer = void 0;
		}
		this.flushStderr();
		const listeners = [...this.closeListeners];
		this.closeListeners.clear();
		this.messageListeners.clear();
		for (const listener of listeners) try {
			listener(this.closing ? void 0 : error);
		} catch {}
	}
};
/** 启动一个 stdio LSP 服务器进程并返回传输层；启动失败通过 onClose 报告。 */
function spawnLspTransport(options) {
	return new ChildProcessTransport(options);
}
//#endregion
//#region src/language/lsp/external.ts
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isDefined(value) {
	return value !== void 0;
}
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
function numberValue$1(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
function optionalString(value) {
	return typeof value === "string" ? value : void 0;
}
function toWirePosition(position) {
	return {
		line: position.line,
		character: position.character
	};
}
function toWireRange(range) {
	return {
		start: toWirePosition(range.start),
		end: toWirePosition(range.end)
	};
}
function fromWirePosition(value) {
	const record = isRecord$1(value) ? value : {};
	return {
		line: numberValue$1(record.line),
		character: numberValue$1(record.character)
	};
}
function fromWireRange(value) {
	const record = isRecord$1(value) ? value : {};
	return {
		start: fromWirePosition(record.start),
		end: fromWirePosition(record.end)
	};
}
/** MarkupContent / MarkedString / string 统一成展示文本。 */
function markupText(value) {
	if (typeof value === "string") return value;
	if (isRecord$1(value) && typeof value.value === "string") return value.value;
}
function fencedCode(language, value) {
	return `\`\`\`${typeof language === "string" ? language : ""}\n${value}\n\`\`\``;
}
/** Hover.contents 允许四种形态：string、MarkupContent、MarkedString、MarkedString[]。 */
function hoverText(contents) {
	if (typeof contents === "string") return contents;
	if (isRecord$1(contents) && typeof contents.value === "string") return contents.value;
	if (!Array.isArray(contents)) return void 0;
	const parts = [];
	for (const part of contents) if (typeof part === "string") parts.push(part);
	else if (isRecord$1(part) && typeof part.value === "string") parts.push(part.language === void 0 ? part.value : fencedCode(part.language, part.value));
	return parts.length === 0 ? void 0 : parts.join("\n\n");
}
const SYMBOL_KIND_BY_NUMBER = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enumMember",
	23: "struct",
	24: "event",
	25: "operator",
	26: "typeParameter"
};
const COMPLETION_KIND_BY_NUMBER = {
	1: "string",
	2: "method",
	3: "function",
	4: "constructor",
	5: "field",
	6: "variable",
	7: "class",
	8: "interface",
	9: "module",
	10: "property",
	11: "object",
	12: "variable",
	13: "enum",
	14: "key",
	15: "string",
	16: "string",
	17: "file",
	18: "string",
	19: "file",
	20: "enumMember",
	21: "constant",
	22: "struct",
	23: "event",
	24: "operator",
	25: "typeParameter"
};
function symbolKind(value) {
	return typeof value === "number" ? SYMBOL_KIND_BY_NUMBER[value] ?? "variable" : "variable";
}
function completionKind(value) {
	return typeof value === "number" ? COMPLETION_KIND_BY_NUMBER[value] : void 0;
}
function textEditFrom(value) {
	if (!isRecord$1(value) || !isRecord$1(value.range) || typeof value.newText !== "string") return void 0;
	return {
		range: fromWireRange(value.range),
		newText: value.newText
	};
}
/**
* WorkspaceEdit → 公共协议。
*
* 只处理文本编辑：`changes` 与 `documentChanges` 里的 TextDocumentEdit。CreateFile/RenameFile 这类
* 资源操作没有对应的公共类型，跳过（重命名/快速修复实际几乎不会返回它们）。
*/
function workspaceEditFrom(value) {
	if (!isRecord$1(value)) return void 0;
	const files = /* @__PURE__ */ new Map();
	const add = (uri, edits) => {
		if (typeof uri !== "string" || !Array.isArray(edits)) return;
		const path = uriToPath(uri);
		if (path === void 0) return;
		const converted = edits.map(textEditFrom).filter(isDefined);
		if (converted.length === 0) return;
		const existing = files.get(path);
		if (existing === void 0) files.set(path, converted);
		else existing.push(...converted);
	};
	if (isRecord$1(value.changes)) for (const [uri, edits] of Object.entries(value.changes)) add(uri, edits);
	if (Array.isArray(value.documentChanges)) for (const change of value.documentChanges) {
		if (!isRecord$1(change) || !isRecord$1(change.textDocument)) continue;
		add(change.textDocument.uri, change.edits);
	}
	if (files.size === 0) return void 0;
	return { changes: [...files.entries()].map(([path, edits]) => ({
		path,
		edits
	})) };
}
/** Definition 允许 Location 或 LocationLink（linkSupport=true 时服务器可能回后者）。 */
function locationsFrom(value) {
	const items = Array.isArray(value) ? value : value === null || value === void 0 ? [] : [value];
	const locations = [];
	for (const item of items) {
		if (!isRecord$1(item)) continue;
		if (typeof item.uri === "string") {
			const path = uriToPath(item.uri);
			if (path !== void 0 && isRecord$1(item.range)) locations.push({
				path,
				range: fromWireRange(item.range)
			});
			continue;
		}
		if (typeof item.targetUri !== "string") continue;
		const path = uriToPath(item.targetUri);
		const range = isRecord$1(item.targetSelectionRange) ? item.targetSelectionRange : item.targetRange;
		if (path !== void 0 && isRecord$1(range)) locations.push({
			path,
			range: fromWireRange(range)
		});
	}
	return locations;
}
function documentSymbolFrom(value) {
	if (!isRecord$1(value) || typeof value.name !== "string") return void 0;
	const rangeValue = isRecord$1(value.range) ? value.range : isRecord$1(value.location) && isRecord$1(value.location.range) ? value.location.range : void 0;
	if (rangeValue === void 0) return void 0;
	const range = fromWireRange(rangeValue);
	const selectionRange = isRecord$1(value.selectionRange) ? fromWireRange(value.selectionRange) : range;
	const children = Array.isArray(value.children) ? value.children.map(documentSymbolFrom).filter(isDefined) : [];
	const symbol = {
		name: value.name,
		kind: symbolKind(value.kind),
		range,
		selectionRange,
		...children.length === 0 ? {} : { children }
	};
	const detail = optionalString(value.detail) ?? optionalString(value.containerName);
	if (detail !== void 0) symbol.detail = detail;
	return symbol;
}
function symbolInformationFrom(value) {
	if (!isRecord$1(value) || typeof value.name !== "string" || !isRecord$1(value.location)) return void 0;
	if (typeof value.location.uri !== "string" || !isRecord$1(value.location.range)) return void 0;
	const path = uriToPath(value.location.uri);
	if (path === void 0) return void 0;
	const information = {
		name: value.name,
		kind: symbolKind(value.kind),
		path,
		range: fromWireRange(value.location.range)
	};
	const containerName = optionalString(value.containerName);
	if (containerName !== void 0) information.containerName = containerName;
	return information;
}
function completionItemFrom(value) {
	if (!isRecord$1(value) || typeof value.label !== "string") return void 0;
	const item = { label: value.label };
	const detail = optionalString(value.detail);
	if (detail !== void 0) item.detail = detail;
	const documentation = markupText(value.documentation);
	if (documentation !== void 0) item.documentation = documentation;
	const kind = completionKind(value.kind);
	if (kind !== void 0) item.kind = kind;
	if (isRecord$1(value.textEdit)) {
		if (typeof value.textEdit.newText === "string") item.insertText = value.textEdit.newText;
		const rangeValue = isRecord$1(value.textEdit.range) ? value.textEdit.range : isRecord$1(value.textEdit.replace) ? value.textEdit.replace : void 0;
		if (rangeValue !== void 0) item.replaceRange = fromWireRange(rangeValue);
	} else if (typeof value.insertText === "string") item.insertText = value.insertText;
	const sortText = optionalString(value.sortText);
	if (sortText !== void 0) item.sortText = sortText;
	const filterText = optionalString(value.filterText);
	if (filterText !== void 0) item.filterText = filterText;
	if (Array.isArray(value.additionalTextEdits)) {
		const additionalEdits = value.additionalTextEdits.map(textEditFrom).filter(isDefined);
		if (additionalEdits.length > 0) item.additionalEdits = additionalEdits;
	}
	return item;
}
function completionListFrom(value) {
	const rawItems = Array.isArray(value) ? value : isRecord$1(value) && Array.isArray(value.items) ? value.items : void 0;
	if (rawItems === void 0) return null;
	const list = { items: rawItems.map(completionItemFrom).filter(isDefined) };
	if (isRecord$1(value) && typeof value.isIncomplete === "boolean") list.incomplete = value.isIncomplete;
	return list;
}
function parameterLabel(label, signatureLabel) {
	if (typeof label === "string") return label;
	if (Array.isArray(label) && label.length === 2 && typeof label[0] === "number" && typeof label[1] === "number") return signatureLabel.slice(label[0], label[1]);
	return "";
}
function signatureHelpFrom(value) {
	if (!isRecord$1(value) || !Array.isArray(value.signatures)) return null;
	const signatures = [];
	for (const rawSignature of value.signatures) {
		if (!isRecord$1(rawSignature) || typeof rawSignature.label !== "string") continue;
		const signature = {
			label: rawSignature.label,
			parameters: []
		};
		const documentation = markupText(rawSignature.documentation);
		if (documentation !== void 0) signature.documentation = documentation;
		if (Array.isArray(rawSignature.parameters)) {
			const parameters = [];
			for (const rawParameter of rawSignature.parameters) {
				if (!isRecord$1(rawParameter)) continue;
				const parameter = { label: parameterLabel(rawParameter.label, rawSignature.label) };
				const parameterDocumentation = markupText(rawParameter.documentation);
				if (parameterDocumentation !== void 0) parameter.documentation = parameterDocumentation;
				parameters.push(parameter);
			}
			signature.parameters = parameters;
		}
		if (typeof rawSignature.activeParameter === "number") signature.activeParameter = rawSignature.activeParameter;
		signatures.push(signature);
	}
	if (signatures.length === 0) return null;
	const help = { signatures };
	if (typeof value.activeSignature === "number") help.activeSignature = value.activeSignature;
	if (typeof value.activeParameter === "number") help.activeParameter = value.activeParameter;
	return help;
}
/** 只有带 edit 的动作能应用；Command 类（没有编辑）按设计丢弃。 */
function codeActionFrom(value) {
	if (!isRecord$1(value) || typeof value.title !== "string") return void 0;
	const edit = workspaceEditFrom(value.edit);
	if (edit === void 0) return void 0;
	const action = {
		title: value.title,
		edit
	};
	const kind = optionalString(value.kind);
	if (kind !== void 0) action.kind = kind;
	if (typeof value.isPreferred === "boolean") action.isPreferred = value.isPreferred;
	return action;
}
function wireSeverity(severity) {
	switch (severity) {
		case "error": return 1;
		case "warning": return 2;
		case "info": return 3;
		case "hint": return 4;
	}
}
function wireDiagnostic(diagnostic) {
	return {
		range: toWireRange(diagnostic.range),
		severity: wireSeverity(diagnostic.severity),
		message: diagnostic.message,
		...diagnostic.code === void 0 ? {} : { code: diagnostic.code },
		...diagnostic.source === void 0 ? {} : { source: diagnostic.source }
	};
}
function createExternalProvider(options) {
	return new ExternalLanguageProvider(options);
}
var ExternalLanguageProvider = class {
	info;
	server;
	options;
	documents = /* @__PURE__ */ new Map();
	opened = /* @__PURE__ */ new Set();
	syncChain = Promise.resolve();
	client;
	startPromise;
	startFailure;
	stateValue = "idle";
	detailValue;
	disposed = false;
	constructor(options) {
		this.options = options;
		this.server = options.server;
		this.info = {
			id: options.server.id,
			name: options.server.name,
			languages: [...options.server.languages],
			kind: "external"
		};
	}
	/** 运行状态（初始化中/运行中/失败/已停用）；管理器据此画状态栏。 */
	get state() {
		return this.stateValue;
	}
	get detail() {
		return this.detailValue;
	}
	openDocument(document) {
		if (this.disposed) return;
		this.documents.set(document.path, document);
		this.enqueue(async () => {
			const client = await this.ensureClient();
			if (client === void 0) return;
			const current = this.documents.get(document.path);
			if (current === void 0 || this.opened.has(document.path)) return;
			this.opened.add(document.path);
			client.didOpen(current);
		});
	}
	changeDocument(document) {
		if (this.disposed) return;
		this.documents.set(document.path, document);
		this.enqueue(async () => {
			const client = await this.ensureClient();
			if (client === void 0) return;
			const current = this.documents.get(document.path);
			if (current === void 0) return;
			if (!this.opened.has(document.path)) {
				this.opened.add(document.path);
				client.didOpen(current);
				return;
			}
			client.didChange(current);
		});
	}
	closeDocument(path) {
		if (this.disposed) return;
		this.documents.delete(path);
		if (!this.opened.delete(path)) return;
		this.enqueue(() => {
			this.client?.didClose(path);
		});
	}
	hover(path, position, signal) {
		return this.requestWith(null, "textDocument/hover", this.textDocumentPositionParams(path, position), signal, (result) => {
			if (!isRecord$1(result)) return null;
			const contents = hoverText(result.contents);
			if (contents === void 0 || contents === "") return null;
			const hover = { contents };
			if (isRecord$1(result.range)) hover.range = fromWireRange(result.range);
			return hover;
		});
	}
	definition(path, position, signal) {
		return this.requestWith([], "textDocument/definition", this.textDocumentPositionParams(path, position), signal, locationsFrom);
	}
	references(path, position, signal) {
		return this.requestWith([], "textDocument/references", {
			...this.textDocumentPositionParams(path, position),
			context: { includeDeclaration: true }
		}, signal, locationsFrom);
	}
	async rename(path, position, newName, signal) {
		const client = await this.ensureClient();
		if (client === void 0) return {
			canRename: false,
			message: "语言服务器未启动"
		};
		try {
			const result = await client.request("textDocument/rename", {
				textDocument: { uri: pathToUri(path) },
				position: toWirePosition(position),
				newName
			}, signal);
			if (result === null || result === void 0) return {
				canRename: false,
				message: "语言服务器不支持重命名此符号"
			};
			const edit = workspaceEditFrom(result);
			if (edit === void 0) return {
				canRename: false,
				message: "语言服务器没有返回可应用的重命名编辑"
			};
			return {
				canRename: true,
				edit
			};
		} catch (error) {
			const message = messageOf$1(error);
			this.writeLog("warn", `textDocument/rename failed: ${message}`);
			return {
				canRename: false,
				message
			};
		}
	}
	async documentSymbols(path, signal) {
		return this.requestWith([], "textDocument/documentSymbol", { textDocument: { uri: pathToUri(path) } }, signal, (result) => {
			return (Array.isArray(result) ? result : []).map(documentSymbolFrom).filter(isDefined);
		});
	}
	async workspaceSymbols(query, limit, signal) {
		const maximum = Math.max(0, Math.min(1e3, Math.floor(limit)));
		return this.requestWith([], "workspace/symbol", { query }, signal, (result) => {
			return (Array.isArray(result) ? result : []).map(symbolInformationFrom).filter(isDefined).slice(0, maximum);
		});
	}
	async completion(path, position, triggerCharacter, signal) {
		const params = {
			...this.textDocumentPositionParams(path, position),
			context: triggerCharacter === void 0 ? { triggerKind: 1 } : {
				triggerKind: 2,
				triggerCharacter
			}
		};
		return this.requestWith(null, "textDocument/completion", params, signal, completionListFrom);
	}
	async signatureHelp(path, position, signal) {
		return this.requestWith(null, "textDocument/signatureHelp", this.textDocumentPositionParams(path, position), signal, signatureHelpFrom);
	}
	async codeActions(path, range, diagnostics, signal) {
		const params = {
			textDocument: { uri: pathToUri(path) },
			range: toWireRange(range),
			context: { diagnostics: diagnostics.map(wireDiagnostic) }
		};
		return this.requestWith([], "textDocument/codeAction", params, signal, (result) => {
			return (Array.isArray(result) ? result : []).map(codeActionFrom).filter(isDefined);
		});
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.documents.clear();
		this.opened.clear();
		const pendingStart = this.startPromise;
		if (pendingStart !== void 0) try {
			await pendingStart;
		} catch {}
		const client = this.client;
		this.client = void 0;
		if (client !== void 0) try {
			await client.stop();
		} catch (error) {
			this.writeLog("warn", `停止语言服务器失败：${messageOf$1(error)}`);
		}
		this.setState("disabled");
	}
	textDocumentPositionParams(path, position) {
		return {
			textDocument: { uri: pathToUri(path) },
			position: toWirePosition(position)
		};
	}
	/** 统一的请求包装：启动失败/请求失败都降级成 fallback，不把异常抛给语言服务管理器。 */
	async requestWith(fallback, method, params, signal, convert) {
		const client = await this.ensureClient();
		if (client === void 0) return fallback;
		try {
			return convert(await client.request(method, params, signal));
		} catch (error) {
			const cancelled = signal?.aborted === true;
			this.writeLog(cancelled ? "info" : "warn", `${method} failed: ${messageOf$1(error)}`);
			return fallback;
		}
	}
	/** 把文档同步任务串成链；单次失败只记日志，后续同步继续。 */
	enqueue(task) {
		this.syncChain = this.syncChain.then(task).catch((error) => this.writeLog("warn", `document sync failed: ${messageOf$1(error)}`));
	}
	async ensureClient() {
		try {
			return await this.startClient();
		} catch {
			return;
		}
	}
	startClient() {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("language provider is disposed"));
		if (this.client !== void 0) return Promise.resolve(this.client);
		if (this.startFailure !== void 0) return Promise.reject(this.startFailure);
		if (this.startPromise !== void 0) return this.startPromise;
		this.setState("starting");
		const pending = this.launch().finally(() => {
			if (this.startPromise === pending) this.startPromise = void 0;
		});
		this.startPromise = pending;
		return pending;
	}
	async launch() {
		const definition = this.server.definition;
		try {
			const transport = spawnLspTransport({
				command: this.server.executable,
				args: this.server.args,
				cwd: this.options.workspace,
				env: {
					...definition.env ?? {},
					...this.options.env ?? {}
				},
				onStderr: (line) => this.writeLog("info", `[${definition.id}] ${line}`)
			});
			const client = new LspClient({
				transport,
				workspace: this.options.workspace,
				requestTimeoutMs: this.options.requestTimeoutMs,
				onDiagnostics: (path, diagnostics) => {
					if (!this.disposed) this.options.onDiagnostics(path, diagnostics);
				},
				onLog: (level, message) => this.writeLog(level, `[${definition.id}] ${message}`),
				clientName: "dsh-aide"
			});
			transport.onClose((error) => this.handleExit(client, error));
			await client.start({ initializationOptions: definition.initializationOptions });
			if (this.disposed) {
				await client.stop();
				throw new Error("language provider is disposed");
			}
			this.client = client;
			this.setState("running");
			this.writeLog("info", `语言服务器 ${this.server.name} 已启动：${this.server.executable}`);
			return client;
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (this.startFailure === void 0) {
				this.startFailure = failure;
				if (!this.disposed) {
					this.setState("failed", failure.message);
					this.writeLog("error", `语言服务器 ${this.server.name} 启动失败：${failure.message}`);
				}
			}
			throw failure;
		}
	}
	/** 进程退出：已经 dispose 的属于正常收尾；运行中退出则标失败并禁止自动重启（避免崩溃循环）。 */
	handleExit(client, error) {
		if (this.client !== client) return;
		this.client = void 0;
		if (this.disposed) return;
		const failure = error ?? /* @__PURE__ */ new Error("语言服务器进程已退出");
		this.startFailure = failure;
		this.setState("failed", failure.message);
		this.writeLog(error === void 0 ? "info" : "warn", `语言服务器 ${this.server.name} 已退出：${failure.message}`);
	}
	setState(state, detail) {
		if (this.stateValue === state && this.detailValue === detail) return;
		this.stateValue = state;
		this.detailValue = detail;
		this.options.onStateChange?.();
	}
	writeLog(level, message) {
		try {
			this.options.onLog?.(level, message);
		} catch {}
	}
};
//#endregion
//#region src/language/scan.ts
const EMPTY_SCAN$1 = {
	checked: 0,
	errors: 0,
	warnings: 0
};
/** 单文件诊断上限：生成代码/类型爆炸时避免一条文件把消息和面板撑爆。 */
const MAX_DIAGNOSTICS_PER_FILE = 500;
/** Windows / macOS 文件系统大小写不敏感；同时把 TS 的 `/` 路径与 Node 的 `\` 路径归一。 */
function keyOf$1(ts, path) {
	const normalized = resolve(path);
	return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}
/**
* 扫描整个程序。诊断一次性算完后按文件分组回调；单个文件回调之间让出事件循环，方便回退路径
* （非 worker）仍能响应取消，并让进度消息有机会被发出。
*/
async function scanProject(ts, options, onFile, signal, onTotal) {
	if (isAborted$1(signal)) return EMPTY_SCAN$1;
	const openDocuments = new Map(options.openDocuments.map((document) => [keyOf$1(ts, document.path), document]));
	const fileNames = [.../* @__PURE__ */ new Set([...options.rootFiles, ...options.openDocuments.map((document) => document.path)])];
	if (fileNames.length === 0) return EMPTY_SCAN$1;
	const host = {
		getSourceFile: (fileName, languageVersion) => {
			const text = openDocuments.get(keyOf$1(ts, fileName))?.content ?? ts.sys.readFile(fileName);
			return text === void 0 ? void 0 : ts.createSourceFile(fileName, text, languageVersion, true);
		},
		getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
		writeFile: () => {},
		getCurrentDirectory: () => options.workspace,
		getCanonicalFileName: (fileName) => ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
		getDirectories: (path) => ts.sys.getDirectories(path),
		fileExists: (fileName) => ts.sys.fileExists(fileName),
		readFile: (fileName) => ts.sys.readFile(fileName),
		readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(path, extensions, exclude, include, depth),
		...ts.sys.realpath === void 0 ? {} : { realpath: (path) => ts.sys.realpath?.(path) ?? path },
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
		getNewLine: () => ts.sys.newLine
	};
	let program;
	try {
		program = ts.createProgram({
			rootNames: fileNames,
			options: options.compilerOptions,
			host
		});
	} catch {
		return {
			...EMPTY_SCAN$1,
			error: "TypeScript 程序创建失败"
		};
	}
	if (isAborted$1(signal)) return EMPTY_SCAN$1;
	const sourceFiles = program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile);
	onTotal?.(sourceFiles.length);
	if (sourceFiles.length === 0) return EMPTY_SCAN$1;
	let raw;
	try {
		raw = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
	} catch {
		return {
			...EMPTY_SCAN$1,
			error: "TypeScript 诊断计算失败"
		};
	}
	if (isAborted$1(signal)) return EMPTY_SCAN$1;
	const byFile = /* @__PURE__ */ new Map();
	for (const diagnostic of raw) {
		const file = diagnostic.file;
		if (file === void 0 || diagnostic.start === void 0) continue;
		const key = keyOf$1(ts, file.fileName);
		const bucket = byFile.get(key);
		if (bucket === void 0) byFile.set(key, [diagnostic]);
		else bucket.push(diagnostic);
	}
	let checked = 0;
	let errors = 0;
	let warnings = 0;
	for (const [index, sourceFile] of sourceFiles.entries()) {
		if (isAborted$1(signal)) break;
		const path = sourceFile.fileName;
		const diagnostics = convertFileDiagnostics(ts, sourceFile, byFile.get(keyOf$1(ts, path)) ?? []);
		checked++;
		for (const diagnostic of diagnostics) if (diagnostic.severity === "error") errors++;
		else if (diagnostic.severity === "warning") warnings++;
		try {
			onFile(path, diagnostics);
		} catch {}
		if (index % 64 === 63) await new Promise((resolveYield) => setImmediate(resolveYield));
	}
	return {
		checked,
		errors,
		warnings
	};
}
/** TS diagnostic（带绝对偏移）→ 协议诊断（0 基行列）。 */
function convertFileDiagnostics(ts, sourceFile, diagnostics) {
	const result = [];
	for (const diagnostic of diagnostics) {
		const file = diagnostic.file;
		if (file === void 0 || diagnostic.start === void 0) continue;
		const text = file.text;
		const related = relatedInformationOf(ts, diagnostic);
		const tags = tagsOf$1(diagnostic);
		result.push({
			range: spanRange$1(ts, file, diagnostic.start, diagnostic.length ?? 0, text.length),
			severity: severityOf$1(diagnostic.category),
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
			code: `TS${diagnostic.code}`,
			source: "ts",
			...tags === void 0 ? {} : { tags },
			...related.length === 0 ? {} : { related }
		});
	}
	return result.sort((left, right) => comparePosition$1(left.range.start, right.range.start) || severityRank(left.severity) - severityRank(right.severity)).slice(0, MAX_DIAGNOSTICS_PER_FILE);
}
function relatedInformationOf(ts, diagnostic) {
	const related = [];
	for (const information of diagnostic.relatedInformation ?? []) {
		const file = information.file;
		if (file === void 0 || information.start === void 0) continue;
		related.push({
			path: file.fileName,
			range: spanRange$1(ts, file, information.start, information.length ?? 0, file.text.length),
			message: ts.flattenDiagnosticMessageText(information.messageText, " ")
		});
	}
	return related;
}
function spanRange$1(ts, file, start, length, textLength) {
	const safeStart = Math.max(0, Math.min(start, textLength));
	const safeEnd = Math.max(safeStart, Math.min(start + length, textLength));
	return {
		start: positionAt$1(ts, file, safeStart),
		end: positionAt$1(ts, file, safeEnd)
	};
}
function positionAt$1(ts, file, offset) {
	const position = ts.getLineAndCharacterOfPosition(file, offset);
	return {
		line: position.line,
		character: position.character
	};
}
function severityOf$1(category) {
	switch (category) {
		case 1: return "error";
		case 0: return "warning";
		default: return "info";
	}
}
function tagsOf$1(diagnostic) {
	const tags = [];
	if (diagnostic.reportsUnnecessary !== void 0) tags.push("unnecessary");
	if (diagnostic.reportsDeprecated !== void 0) tags.push("deprecated");
	return tags.length === 0 ? void 0 : tags;
}
function severityRank(severity) {
	switch (severity) {
		case "error": return 0;
		case "warning": return 1;
		case "info": return 2;
		default: return 3;
	}
}
function comparePosition$1(left, right) {
	return left.line !== right.line ? left.line - right.line : left.character - right.character;
}
function isAborted$1(signal) {
	return signal?.aborted === true;
}
//#endregion
//#region src/language/typescript.ts
/**
* 内置 TypeScript 语言服务（宿主侧 provider）。
*
* 为什么是「内置」而不是起一个 tsserver 子进程：AIDE 的补全链路已经在宿主进程里跑，诊断与跳转只需要
* 工作区的编译器视图，不需要另一份进程、协议与生命周期；代价是所有计算都占用宿主单线程，所以这里把
* 重活（首次加载 lib、语义检查）做成「首次用到才做」，且工作区扫描有文件数与单文件大小上限。
*
* 三件事决定了这一层的形状：
*   1. **TypeScript 是懒加载的**：模块顶层不 import `typescript`，首次异步操作时才动态 import。宿主
*      bundle 里 typescript 是外部化依赖（node_modules 已有），这样只在真正打开补全/诊断时才付出加载
*      成本；构造函数与文档同步（open/change/close）必须同步、轻量。
*   2. **内存正文优先**：客户端推送的正文（可能还没落盘）是唯一真相；磁盘只在「没打开」时读，并用
*      mtime+size 生成版本号，让 TypeScript 自己感知磁盘变化。
*   3. **不给路由层抛异常**：TypeScript 的 API 会在半损坏的文件、被删的模块、不完整的配置上抛错。
*      这一层吞掉异常、写一条 warn 日志、返回空结果 —— 语言服务失败不该让整个工作台请求 500。
*
* 坐标约定：本文件只在边界上与协议交互，内部一律使用 UTF-16 字符偏移（TypeScript 的 TextSpan），
* 输出时转换成 0 基行列（见 protocol.ts）。行列都从 0 开始。
*/
/** 参与扫描（没有 tsconfig 时）的扩展名。d.ts 也以 `.ts` 结尾，一并算作工作区源文件。 */
const SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs"
]);
/**
* 扫描时整目录跳过的名字。
*
* 除了依赖与产物目录，还跳过一切以 `.` 开头的目录（.git/.next/.turbo/.cache/.vscode/.dsh-workbench…）：
* 它们要么不是源码，要么是工具缓存，扫进来只会让首次程序构建变慢。
*/
const SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set([
	"node_modules",
	"dist",
	"build",
	"lib",
	"out",
	"coverage",
	"target",
	"bin",
	"obj"
]);
/** 扫描上限：超过之后补全/诊断只会更慢，不如明确放弃（并在日志里说明）。 */
const MAX_WORKSPACE_FILES = 6e3;
/** 单个源文件上限：日志、生成物这类大文件放进程序只会拖垮语义检查。 */
const MAX_SOURCE_FILE_BYTES = 1048576;
/** readFile 对外可读内容上限（2 MiB），超过视为「不属于本服务该给客户端看的内容」。 */
const MAX_READ_FILE_CHARS = 2097152;
/** lineStarts 缓存条目上限：切文件很频繁时避免无界增长。 */
const MAX_LINE_CACHE_ENTRIES = 256;
/** worker 失败后允许宿主进程内回退的最大根文件数：再大就只报错，避免宿主 OOM。 */
const IN_PROCESS_SCAN_MAX_FILES = 400;
/** worker 堆上限：TypeScript 大项目很容易超过 1.5GB；超限只让 worker 退出，宿主必须存活。 */
const SCAN_WORKER_HEAP_MB = 1536;
/** 传给 worker 的打开文档上限：避免几 MB 的未保存正文被 structured clone 进 worker。 */
const MAX_WORKER_OPEN_DOCS = 32;
const MAX_WORKER_OPEN_BYTES = 8388608;
const EMPTY_SCAN = {
	checked: 0,
	errors: 0,
	warnings: 0
};
/** 生产构建里由 tsdown 额外产出的扫描 worker；源码测试环境不存在，走进程内回退。 */
const SCAN_WORKER_URL = new URL("./scan-worker.js", import.meta.url);
let scanWorkerAvailable;
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 取消检查做成函数：避免控制流分析把同一作用域里后续的 `signal?.aborted === true` 判成不可能。 */
function isAborted(signal) {
	return signal?.aborted === true;
}
/** 计算每一行起始偏移；用于把 TS 的字符偏移映射成 0 基行列。 */
function computeLineStarts(text) {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
	return starts;
}
/** 偏移 → 0 基行列（starts 必须来自同一份 text）。 */
function positionAt(starts, textLength, offset) {
	const target = Math.max(0, Math.min(offset, textLength));
	let low = 0;
	let high = Math.max(0, starts.length - 1);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((starts[middle] ?? 0) <= target) low = middle;
		else high = middle - 1;
	}
	return {
		line: low,
		character: target - (starts[low] ?? 0)
	};
}
/** TextSpan（可能缺 length）→ 协议范围。 */
function spanRange(starts, textLength, span) {
	const start = Math.max(0, span.start);
	return {
		start: positionAt(starts, textLength, start),
		end: positionAt(starts, textLength, start + Math.max(0, span.length))
	};
}
/** 0 基行列 → 字符偏移：行内列号夹到该行末尾（不越过换行符，CRLF 时也不越过 \r）。 */
function offsetAtPosition(text, starts, position) {
	const lineCount = starts.length;
	const line = Math.max(0, Math.min(position.line, lineCount - 1));
	const start = starts[line] ?? 0;
	const nextLineStart = starts[line + 1] ?? text.length;
	const newlineStart = line + 1 < lineCount ? Math.max(start, nextLineStart - 1) : text.length;
	const lineEnd = newlineStart > start && text.charCodeAt(newlineStart - 1) === 13 ? newlineStart - 1 : newlineStart;
	return Math.min(start + Math.max(0, position.character), lineEnd);
}
function displayPartsText(parts) {
	return (parts ?? []).map((part) => part.text).join("");
}
/**
* TypeScript 的 ScriptElementKind（字符串枚举）→ 协议里的 LSP 风格 SymbolKind。
*
* 两边的分类并不一一对应（TS 有 keyword/alias/primitive type 这些 LSP 没有「符号种类」的概念），
* 取最接近的一项；未知值退化成 variable，宁可分类粗略，也不让客户端因为未知字符串而丢掉条目。
*/
function symbolKindOf(kind) {
	switch (kind) {
		case "class":
		case "local class": return "class";
		case "interface":
		case "type":
		case "primitive type": return "interface";
		case "enum": return "enum";
		case "enum member": return "enumMember";
		case "module":
		case "script":
		case "external module name":
		case "alias": return "module";
		case "directory": return "file";
		case "function":
		case "local function": return "function";
		case "method": return "method";
		case "getter":
		case "setter":
		case "property":
		case "accessor": return "property";
		case "constructor": return "constructor";
		case "var":
		case "local var":
		case "let":
		case "using":
		case "local using":
		case "parameter": return "variable";
		case "const": return "constant";
		case "type parameter": return "typeParameter";
		case "string": return "string";
		case "label":
		case "keyword": return "key";
		default: return "variable";
	}
}
/** TS DiagnosticCategory → 协议严重级别（Suggestion/Message 都是弱提示，归 info）。 */
function severityOf(category) {
	switch (category) {
		case 1: return "error";
		case 0: return "warning";
		default: return "info";
	}
}
/** 未使用/已弃用标记：客户端据此把对应文字画淡。 */
function tagsOf(diagnostic) {
	const tags = [];
	if (diagnostic.reportsUnnecessary !== void 0) tags.push("unnecessary");
	if (diagnostic.reportsDeprecated !== void 0) tags.push("deprecated");
	return tags.length === 0 ? void 0 : tags;
}
/** 默认（没有 tsconfig 时）的编译设置：宽松、只看语法与明显类型错误，不要求工程化配置。 */
function defaultCompilerOptions(ts) {
	return {
		allowJs: true,
		checkJs: false,
		jsx: ts.JsxEmit.Preserve,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: false,
		noImplicitAny: false,
		noEmit: true,
		skipLibCheck: true,
		esModuleInterop: true,
		allowSyntheticDefaultImports: true,
		forceConsistentCasingInFileNames: true
	};
}
/**
* 把 tsconfig 里的 options 收敛成「只读、不产出」的形态。
*
* 语言服务不需要 emit，而且 composite/declaration 与 noEmit 组合会被 TS 当成配置错误；这里强制关掉
* 与产出相关的开关，避免一个本来用于 `tsc -b` 的工程配置让语言服务拒绝工作。其余选项（target、module、
* paths、strict…）原样保留：诊断结果必须与用户的编译配置一致。
*/
function sanitizeCompilerOptions(options) {
	return {
		...options,
		noEmit: true,
		incremental: false,
		composite: false,
		declaration: false,
		declarationMap: false,
		emitDeclarationOnly: false,
		tsBuildInfoFile: void 0
	};
}
/** 判断一个目录名是否应当跳过扫描。 */
function shouldSkipDirectory(name) {
	return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}
/**
* 内置 TypeScript 语言服务。
*
* 生命周期：构造（同步、不加载 TS）→ 首次异步操作时初始化（动态 import + 读 tsconfig/扫描 + 建 service）
* → 客户端 open/change/close 同步更新内存正文 → dispose。任何公开方法在 dispose 之后都返回空结果而不是抛错。
*/
var TypeScriptLanguageProvider = class {
	info = {
		id: BUILTIN_TYPESCRIPT_ID,
		name: "内置 TypeScript",
		languages: [
			"typescript",
			"javascript",
			"javascriptreact",
			"typescriptreact"
		],
		kind: "builtin"
	};
	workspace;
	options;
	caseSensitive;
	/** 磁盘文件版本号的缓存时长：TS 每次同步都会对程序内每个文件调 getScriptVersion，逐次 stat 太贵。 */
	diskVersionCacheMs;
	ts;
	service;
	initPromise;
	disposed = false;
	/** 程序根文件（tsconfig 的 fileNames，或扫描结果）。 */
	rootFiles = [];
	settings = {};
	/** 根文件/编译设置是否已加载；扫描可在不创建宿主语言服务/程序的情况下只做这一步。 */
	projectLoaded = false;
	formatOptions;
	openDocuments = /* @__PURE__ */ new Map();
	diskVersions = /* @__PURE__ */ new Map();
	diagnosticsCache = /* @__PURE__ */ new Map();
	lineCache = /* @__PURE__ */ new Map();
	/**
	* @param options provider 选项（工作区、诊断回调、日志）。
	* @param internals 只为测试/调优保留的内部开关；不改变 LanguageProvider 契约。
	*/
	constructor(options, internals = {}) {
		this.options = options;
		this.workspace = resolve(options.workspace);
		this.caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
		this.diskVersionCacheMs = internals.diskVersionCacheMs ?? 2e3;
	}
	openDocument(document) {
		if (this.disposed) return;
		this.storeDocument(document, false);
	}
	changeDocument(document) {
		if (this.disposed) return;
		this.storeDocument(document, true);
	}
	closeDocument(path) {
		if (this.disposed) return;
		this.openDocuments.delete(this.keyOf(path));
	}
	/**
	* 记录客户端正文。
	*
	* `changeDocument` 会丢弃版本号倒退的请求：网络乱序时旧正文覆盖新正文，会让诊断/跳转用到过期内容，
	* 这比「丢一次更新」严重得多。open 不做这个检查 —— 重新打开同一个文件是新一轮版本序列。
	*/
	storeDocument(document, isChange) {
		const key = this.keyOf(document.path);
		const existing = this.openDocuments.get(key);
		if (isChange && existing !== void 0 && document.version < existing.version) return;
		this.openDocuments.set(key, {
			path: this.absolute(document.path),
			languageId: document.languageId,
			version: document.version,
			content: document.content
		});
	}
	async ensureService() {
		this.initPromise ??= this.initialize();
		await this.initPromise;
		if (this.disposed) return void 0;
		const ts = this.ts;
		const service = this.service;
		return ts === void 0 || service === void 0 ? void 0 : {
			ts,
			service
		};
	}
	/** 首次异步操作时加载 typescript、准备程序根并创建语言服务；失败只留日志，之后每次调用都返回空结果。 */
	async initialize() {
		try {
			const ts = await import("typescript");
			if (this.disposed) return;
			this.ts = ts;
			if (!this.projectLoaded) {
				await this.loadProject(ts);
				this.projectLoaded = true;
			}
			if (this.disposed) return;
			this.formatOptions = ts.getDefaultFormatCodeSettings("\n");
			this.service = ts.createLanguageService(this.createHost(ts), ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, this.workspace));
		} catch (error) {
			this.warn(`初始化失败：${messageOf(error)}`);
		}
	}
	/** 有 tsconfig 就按它来（include/exclude/files 全部生效）；没有就扫描工作区。 */
	async loadProject(ts) {
		const configPath = ts.findConfigFile(this.workspace, ts.sys.fileExists);
		if (configPath !== void 0) try {
			const read = ts.readConfigFile(configPath, ts.sys.readFile);
			if (read.error !== void 0) this.warn(`读取 ${configPath} 失败：${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
			else {
				const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), void 0, configPath);
				if (parsed.errors.length > 0) {
					const first = parsed.errors[0];
					if (first !== void 0) this.warn(`${configPath} 有配置问题：${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);
				}
				this.rootFiles = parsed.fileNames.map((fileName) => this.absolute(fileName));
				this.settings = sanitizeCompilerOptions(parsed.options);
				return;
			}
		} catch (error) {
			this.warn(`解析 ${configPath} 失败，回退到目录扫描：${messageOf(error)}`);
		}
		this.rootFiles = await this.scanWorkspace();
		this.settings = defaultCompilerOptions(ts);
	}
	/**
	* 没有 tsconfig 时的兜底文件发现。
	*
	* 广度优先遍历、按文件名排序，保证同一目录下的结果稳定（程序根顺序会影响符号顺序与测试可重复性）。
	* 上限与跳过目录见文件顶部常量：宁可少收文件，也不能让打开工作台时卡在扫描上。
	*/
	async scanWorkspace() {
		const files = [];
		const queue = [this.workspace];
		while (queue.length > 0) {
			const directory = queue.shift();
			let entries;
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				continue;
			}
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				if (files.length >= MAX_WORKSPACE_FILES) break;
				const fullPath = join(directory, entry.name);
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					if (!shouldSkipDirectory(entry.name)) queue.push(fullPath);
					continue;
				}
				if (!entry.isFile()) continue;
				if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
				try {
					if ((await stat(fullPath)).size > MAX_SOURCE_FILE_BYTES) continue;
				} catch {
					continue;
				}
				files.push(fullPath);
			}
			if (files.length >= MAX_WORKSPACE_FILES) {
				this.warn(`工作区文件超过 ${MAX_WORKSPACE_FILES} 个，只把前 ${MAX_WORKSPACE_FILES} 个纳入程序；建议添加 tsconfig.json 明确范围`);
				break;
			}
		}
		return files;
	}
	/** 程序文件 ∪ 客户端已打开文档：打开的文件即使不在 include/扫描结果里也必须能被诊断与跳转。 */
	scriptFileNames() {
		const names = [];
		const seen = /* @__PURE__ */ new Set();
		for (const fileName of this.rootFiles) {
			const key = this.keyOf(fileName);
			if (seen.has(key)) continue;
			seen.add(key);
			names.push(this.absolute(fileName));
		}
		for (const document of this.openDocuments.values()) {
			const key = this.keyOf(document.path);
			if (seen.has(key)) continue;
			seen.add(key);
			names.push(document.path);
		}
		return names;
	}
	/** 构造 LanguageServiceHost；只有 getScriptVersion/getScriptSnapshot 知道「内存正文优先」。 */
	createHost(ts) {
		return {
			getScriptFileNames: () => this.scriptFileNames(),
			getScriptVersion: (fileName) => this.scriptVersion(fileName),
			getScriptSnapshot: (fileName) => {
				const open = this.openDocuments.get(this.keyOf(fileName));
				if (open !== void 0) return ts.ScriptSnapshot.fromString(open.content);
				const text = ts.sys.readFile(this.absolute(fileName));
				return text === void 0 ? void 0 : ts.ScriptSnapshot.fromString(text);
			},
			getCompilationSettings: () => this.settings,
			getCurrentDirectory: () => this.workspace,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			getNewLine: () => ts.sys.newLine,
			getScriptKind: (fileName) => {
				switch (this.openDocuments.get(this.keyOf(fileName))?.languageId) {
					case "typescriptreact": return ts.ScriptKind.TSX;
					case "javascriptreact": return ts.ScriptKind.JSX;
					default: return ts.ScriptKind.Unknown;
				}
			},
			fileExists: (fileName) => ts.sys.fileExists(this.absolute(fileName)),
			readFile: (fileName, encoding) => ts.sys.readFile(this.absolute(fileName), encoding),
			readDirectory: (path, extensions, exclude, include, depth) => ts.sys.readDirectory(this.absolute(path), extensions, exclude, include, depth),
			directoryExists: (path) => ts.sys.directoryExists(this.absolute(path)),
			getDirectories: (path) => ts.sys.getDirectories(this.absolute(path)),
			realpath: (path) => ts.sys.realpath?.(this.absolute(path)) ?? this.absolute(path),
			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
		};
	}
	/**
	* 文件版本：打开文档用客户端版本（内容在内存里）；磁盘文件用 mtime+size。
	*
	* 磁盘版本带短缓存：TypeScript 每次同步都会对程序内每个文件调一次 getScriptVersion，6000 个文件逐次
	* stat 会让每次请求都慢一截。缓存意味着磁盘改动最迟在缓存过期后可见（默认 2 秒）；客户端打开的文档
	* 不受影响，改正文后版本立刻变。
	*/
	scriptVersion(fileName) {
		const key = this.keyOf(fileName);
		const open = this.openDocuments.get(key);
		if (open !== void 0) return String(open.version);
		const now = Date.now();
		const cached = this.diskVersions.get(key);
		if (cached !== void 0 && now - cached.at < this.diskVersionCacheMs) return cached.version;
		let version = "0";
		try {
			const info = statSync(this.absolute(fileName));
			version = `${Math.floor(info.mtimeMs)}:${info.size}`;
		} catch {
			version = "0";
		}
		this.diskVersions.set(key, {
			version,
			at: now
		});
		return version;
	}
	async diagnostics(path) {
		return this.runWithService([], (ts, service) => {
			const fileName = this.absolute(path);
			const computed = this.computeDiagnostics(ts, service, fileName);
			if (computed.fresh) try {
				this.options.onDiagnostics(fileName, computed.diagnostics);
			} catch (error) {
				this.warn(`诊断推送回调失败：${messageOf(error)}`);
			}
			return computed.diagnostics;
		});
	}
	async hover(path, position, signal) {
		return this.runWithService(null, (ts, service) => {
			if (isAborted(signal)) return null;
			const fileName = this.absolute(path);
			const info = service.getQuickInfoAtPosition(fileName, this.offsetIn(fileName, position));
			if (info === void 0) return null;
			const signature = displayPartsText(info.displayParts);
			const documentation = displayPartsText(info.documentation).trim();
			const tags = (info.tags ?? []).map((tag) => `@${tag.name}${tag.text === void 0 ? "" : ` ${displayPartsText(tag.text)}`}`).join("\n");
			if (signature === "" && documentation === "" && tags === "") return null;
			const sections = [`\`\`\`typescript\n${signature}\n\`\`\``];
			if (documentation !== "") sections.push(documentation);
			if (tags !== "") sections.push(tags);
			const range = this.rangeOf(fileName, info.textSpan);
			return {
				contents: sections.join("\n\n"),
				...range === void 0 ? {} : { range }
			};
		});
	}
	async definition(path, position, signal) {
		return this.runWithService([], (_ts, service) => {
			if (isAborted(signal)) return [];
			const fileName = this.absolute(path);
			return (service.getDefinitionAtPosition(fileName, this.offsetIn(fileName, position)) ?? []).map((definition) => this.locationOf(definition.fileName, definition.textSpan)).filter((location) => location !== void 0);
		});
	}
	async references(path, position, signal) {
		return this.runWithService([], (_ts, service) => {
			if (isAborted(signal)) return [];
			const fileName = this.absolute(path);
			const locations = (service.getReferencesAtPosition(fileName, this.offsetIn(fileName, position)) ?? []).map((entry) => this.locationOf(entry.fileName, entry.textSpan)).filter((location) => location !== void 0).sort((left, right) => left.path.localeCompare(right.path) || comparePosition(left.range.start, right.range.start));
			const seen = /* @__PURE__ */ new Set();
			return locations.filter((location) => {
				const key = `${location.path}:${location.range.start.line}:${location.range.start.character}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		});
	}
	async rename(path, position, newName, signal) {
		return this.runWithService({
			canRename: false,
			message: "内置 TypeScript 语言服务不可用"
		}, (_ts, service) => {
			const unavailable = {
				canRename: false,
				message: "内置 TypeScript 语言服务不可用"
			};
			if (isAborted(signal)) return unavailable;
			if (newName.trim() === "") return {
				canRename: false,
				message: "新名称不能为空"
			};
			const fileName = this.absolute(path);
			const offset = this.offsetIn(fileName, position);
			const info = service.getRenameInfo(fileName, offset, {});
			if (!info.canRename) return {
				canRename: false,
				message: `无法重命名：${info.localizedErrorMessage}`
			};
			const locations = service.findRenameLocations(fileName, offset, false, false, {}) ?? [];
			if (locations.length === 0) return {
				canRename: false,
				message: "此处没有可重命名的引用"
			};
			const byFile = /* @__PURE__ */ new Map();
			for (const location of locations) {
				const absolutePath = this.absolute(location.fileName);
				if (!this.fileIsKnown(absolutePath)) continue;
				const range = this.rangeOf(location.fileName, location.textSpan);
				if (range === void 0) continue;
				const key = this.keyOf(absolutePath);
				const group = byFile.get(key) ?? {
					path: absolutePath,
					edits: []
				};
				group.edits.push({
					range,
					newText: newName
				});
				byFile.set(key, group);
			}
			const changes = [...byFile.values()].sort((left, right) => left.path.localeCompare(right.path)).map((group) => ({
				path: group.path,
				edits: [...group.edits].sort((left, right) => comparePosition(left.range.start, right.range.start))
			}));
			if (changes.length === 0) return {
				canRename: false,
				message: "此处没有可重命名的引用"
			};
			return {
				canRename: true,
				edit: { changes }
			};
		});
	}
	async documentSymbols(path, signal) {
		return this.runWithService([], (_ts, service) => {
			if (isAborted(signal)) return [];
			const fileName = this.absolute(path);
			const tree = service.getNavigationTree(fileName);
			const text = this.textOf(fileName);
			if (text === void 0) return [];
			const starts = this.lineStartsFor(fileName, text);
			return (tree.childItems ?? []).map((child) => convertNavigationTree(child, starts, text.length)).filter((symbol) => symbol !== void 0);
		});
	}
	async workspaceSymbols(query, limit, signal) {
		return this.runWithService([], (_ts, service) => {
			if (isAborted(signal)) return [];
			if (query.trim() === "") return [];
			const max = Math.max(1, limit);
			const items = service.getNavigateToItems(query, max, void 0, true);
			const results = [];
			for (const item of items) {
				const range = this.rangeOf(item.fileName, item.textSpan);
				if (range === void 0) continue;
				results.push({
					name: item.name,
					kind: symbolKindOf(item.kind),
					...item.containerName === "" ? {} : { containerName: item.containerName },
					path: this.absolute(item.fileName),
					range
				});
				if (results.length >= max) break;
			}
			return results;
		});
	}
	async completion(path, position, triggerCharacter, signal) {
		return this.runWithService(null, (ts, service) => {
			if (isAborted(signal)) return null;
			const fileName = this.absolute(path);
			const offset = this.offsetIn(fileName, position);
			const info = service.getCompletionsAtPosition(fileName, offset, {
				includeCompletionsWithSnippetText: false,
				...triggerCharacter === void 0 ? {} : { triggerCharacter }
			}, this.formatOptions);
			if (info === void 0) return null;
			return { items: info.entries.map((entry) => {
				const replacement = entry.replacementSpan === void 0 ? void 0 : this.rangeOf(fileName, entry.replacementSpan);
				return {
					label: entry.name,
					kind: symbolKindOf(entry.kind),
					sortText: entry.sortText,
					...entry.filterText === void 0 ? {} : { filterText: entry.filterText },
					...entry.insertText === void 0 ? {} : { insertText: entry.insertText },
					...replacement === void 0 ? {} : { replaceRange: replacement }
				};
			}) };
		});
	}
	async signatureHelp(path, position, signal) {
		return this.runWithService(null, (_ts, service) => {
			if (isAborted(signal)) return null;
			const fileName = this.absolute(path);
			const help = service.getSignatureHelpItems(fileName, this.offsetIn(fileName, position), {});
			if (help === void 0 || help.items.length === 0) return null;
			return {
				signatures: help.items.map((item) => {
					const parameters = item.parameters.map((parameter) => {
						const label = displayPartsText(parameter.displayParts) || parameter.name;
						const documentation = displayPartsText(parameter.documentation).trim();
						return {
							label,
							...documentation === "" ? {} : { documentation }
						};
					});
					const prefix = displayPartsText(item.prefixDisplayParts);
					const suffix = displayPartsText(item.suffixDisplayParts);
					const separator = displayPartsText(item.separatorDisplayParts);
					const label = `${prefix}${parameters.map((parameter) => parameter.label).join(separator)}${suffix}`;
					const documentation = displayPartsText(item.documentation).trim();
					return {
						label,
						...documentation === "" ? {} : { documentation },
						parameters,
						activeParameter: help.argumentIndex
					};
				}),
				activeSignature: help.selectedItemIndex,
				activeParameter: help.argumentIndex
			};
		});
	}
	async codeActions(path, range, diagnostics, signal) {
		return this.runWithService([], (ts, service) => {
			if (isAborted(signal)) return [];
			const fileName = this.absolute(path);
			const text = this.textOf(fileName);
			if (text === void 0) return [];
			const starts = computeLineStarts(text);
			const start = offsetAtPosition(text, starts, range.start);
			const end = Math.max(start, offsetAtPosition(text, starts, range.end));
			const errorCodes = [...new Set(diagnostics.map((diagnostic) => diagnostic.code).filter((code) => code !== void 0 && /^TS\d+$/.test(code)).map((code) => Number(code.slice(2))))];
			const actions = [];
			const formatOptions = this.formatOptions;
			if (formatOptions === void 0) return actions;
			if (errorCodes.length > 0) try {
				for (const fix of service.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, {})) {
					const edit = this.workspaceEditOf(fix.changes);
					actions.push({
						title: fix.description,
						kind: "quickfix",
						...edit === void 0 ? {} : { edit }
					});
				}
			} catch (error) {
				this.warn(`计算快速修复失败：${messageOf(error)}`);
			}
			try {
				const changes = service.organizeImports({
					type: "file",
					fileName
				}, formatOptions, {});
				const edit = this.workspaceEditOf(changes);
				if (edit !== void 0) actions.push({
					title: "整理导入",
					kind: "source.organizeImports",
					edit
				});
			} catch {}
			return actions;
		});
	}
	/**
	* 工作区全量诊断扫描。
	*
	* 只扫程序内**非声明文件**：lib.*.d.ts 与 node_modules 里的 .d.ts 不是用户代码，把它们的错误报出来
	* 只会淹没真正的问题。每个文件之间让出事件循环（setImmediate），这样扫描期间路由仍能响应、也能被取消。
	*/
	async workspaceDiagnostics(onFile, signal, onTotal) {
		if (this.disposed) return EMPTY_SCAN;
		const ts = await this.tsForProject();
		if (ts === void 0 || this.disposed) return EMPTY_SCAN;
		if (isAborted(signal)) return EMPTY_SCAN;
		const openDocuments = [];
		let openBytes = 0;
		for (const document of this.openDocuments.values()) {
			if (openDocuments.length >= MAX_WORKER_OPEN_DOCS) break;
			if (openBytes + document.content.length > MAX_WORKER_OPEN_BYTES) continue;
			openBytes += document.content.length;
			openDocuments.push({
				path: document.path,
				languageId: document.languageId,
				version: document.version,
				content: document.content
			});
		}
		const options = {
			workspace: this.workspace,
			rootFiles: this.scriptFileNames(),
			compilerOptions: this.settings,
			openDocuments
		};
		if (this.canUseScanWorker()) try {
			return await this.workspaceDiagnosticsInWorker(options, onFile, signal, onTotal);
		} catch (error) {
			if (isAborted(signal)) return EMPTY_SCAN;
			this.warn(`工作区扫描 worker 失败：${messageOf(error)}`);
			if (options.rootFiles.length > IN_PROCESS_SCAN_MAX_FILES) return {
				...EMPTY_SCAN,
				error: `扫描 worker 失败或超出内存上限（${messageOf(error)}）；请用 tsconfig 的 include 缩小范围后重试`
			};
		}
		return await scanProject(ts, options, onFile, signal, onTotal);
	}
	/** worker 产物只存在于构建后的 lib/；存在性缓存一次，避免每次扫描 stat。 */
	canUseScanWorker() {
		if (scanWorkerAvailable === void 0) try {
			scanWorkerAvailable = existsSync(fileURLToPath(SCAN_WORKER_URL));
		} catch {
			scanWorkerAvailable = false;
		}
		return scanWorkerAvailable;
	}
	/**
	* 扫描用的 TypeScript 环境：只加载 typescript 和项目根文件/编译设置，不创建语言服务。
	* 这样「没有打开文件就直接扫描」的大工作区不会先在宿主里建一整份程序。
	*/
	async tsForProject() {
		if (this.disposed) return void 0;
		let ts = this.ts;
		if (ts === void 0) {
			try {
				ts = await import("typescript");
			} catch (error) {
				this.warn(`工作区扫描无法加载 TypeScript：${messageOf(error)}`);
				return;
			}
			if (this.disposed) return void 0;
			this.ts = ts;
		}
		if (!this.projectLoaded) try {
			await this.loadProject(ts);
			this.projectLoaded = true;
		} catch (error) {
			this.warn(`工作区扫描无法解析项目：${messageOf(error)}`);
			return;
		}
		return ts;
	}
	async workspaceDiagnosticsInWorker(options, onFile, signal, onTotal) {
		const worker = new Worker(SCAN_WORKER_URL, {
			workerData: options,
			resourceLimits: {
				maxOldGenerationSizeMb: SCAN_WORKER_HEAP_MB,
				maxYoungGenerationSizeMb: 128,
				stackSizeMb: 8
			}
		});
		let checked = 0, errors = 0, warnings = 0;
		let settled = false;
		return await new Promise((resolveScan, rejectScan) => {
			const finish = (result, error) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				worker.terminate();
				if (error === void 0) resolveScan(result);
				else rejectScan(error);
			};
			const abort = () => finish({
				checked,
				errors,
				warnings
			});
			signal?.addEventListener("abort", abort, { once: true });
			worker.on("message", (message) => {
				if (message.type === "files") {
					for (const file of message.files) {
						const diagnostics = file.diagnostics;
						checked++;
						for (const diagnostic of diagnostics) if (diagnostic.severity === "error") errors++;
						else if (diagnostic.severity === "warning") warnings++;
						try {
							onFile(file.path, diagnostics);
						} catch {}
					}
					return;
				}
				if (message.type === "done") {
					finish(message.result);
					return;
				}
				if (message.type === "error") finish({
					checked,
					errors,
					warnings
				}, new Error(message.message));
				if (message.type === "total") onTotal?.(message.total);
			});
			worker.on("error", (error) => finish({
				checked,
				errors,
				warnings
			}, error));
			worker.on("exit", (code) => {
				if (!settled) finish({
					checked,
					errors,
					warnings
				}, code === 0 ? void 0 : /* @__PURE__ */ new Error(`scan worker exited with ${code}`));
			});
		});
	}
	/**
	* 只读文件读取：仅限语言服务程序里的文件（含 lib.*.d.ts 与 node_modules 声明文件）。
	*
	* 客户端要显示「跳转目标」的源码，但工作台的文件 API 只能读工作区内的路径；由这里判断「这个路径确实
	* 是 TS 解析过的文件」再给内容，等于把访问面收敛到语言服务自己的程序，而不是任意路径都能读。
	*/
	async readFile(path) {
		return this.runWithService(void 0, (_ts, service) => {
			const program = service.getProgram();
			if (program === void 0) return void 0;
			const key = this.keyOf(path);
			const absolutePath = this.absolute(path);
			const sourceFile = program.getSourceFile(absolutePath) ?? program.getSourceFiles().find((candidate) => this.keyOf(candidate.fileName) === key);
			if (sourceFile === void 0) return void 0;
			if (sourceFile.text.length > MAX_READ_FILE_CHARS) return void 0;
			return sourceFile.text;
		});
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.service?.dispose();
		} catch {}
		this.service = void 0;
		this.ts = void 0;
		this.initPromise = void 0;
		this.formatOptions = void 0;
		this.settings = {};
		this.openDocuments.clear();
		this.diskVersions.clear();
		this.diagnosticsCache.clear();
		this.lineCache.clear();
		this.rootFiles = [];
		this.projectLoaded = false;
	}
	/** 统一的「初始化 + 异常兜底」外壳：任何失败都返回 fallback，绝不把 TS 异常抛给路由层。 */
	async runWithService(fallback, action) {
		if (this.disposed) return fallback;
		try {
			const ready = await this.ensureService();
			if (ready === void 0 || this.disposed) return fallback;
			return action(ready.ts, ready.service);
		} catch (error) {
			this.warn(`请求失败：${messageOf(error)}`);
			return fallback;
		}
	}
	/**
	* 计算一个文件的诊断（语法 + 语义 + 建议），并按「文件版本 + 程序实例」缓存。
	*
	* 只按文件版本缓存是不够的：A 文件的语义诊断会随 B 文件改动而变。程序实例在任一根文件版本变化时
	* 会被 TypeScript 重建，所以把 `program` 引用一起放进缓存键，跨文件失效也能覆盖。
	* `fresh` 表示这次是否真的计算过（诊断推送只在真计算时发一次）。
	*/
	computeDiagnostics(ts, service, fileName) {
		const program = service.getProgram();
		const key = this.keyOf(fileName);
		const version = this.scriptVersion(fileName);
		const cached = this.diagnosticsCache.get(key);
		if (program !== void 0 && cached !== void 0 && cached.program === program && cached.version === version) return {
			diagnostics: cached.diagnostics,
			fresh: false
		};
		const diagnostics = this.collectDiagnostics(ts, service, fileName);
		if (program !== void 0) this.diagnosticsCache.set(key, {
			program,
			version,
			diagnostics
		});
		return {
			diagnostics,
			fresh: true
		};
	}
	collectDiagnostics(ts, service, fileName) {
		const raw = [];
		try {
			raw.push(...service.getSyntacticDiagnostics(fileName));
			raw.push(...service.getSemanticDiagnostics(fileName));
			raw.push(...service.getSuggestionDiagnostics(fileName));
		} catch (error) {
			this.warn(`计算 ${fileName} 的诊断失败：${messageOf(error)}`);
			return [];
		}
		const result = [];
		for (const diagnostic of raw) {
			const diagnosticFile = diagnostic.file;
			if (diagnosticFile === void 0 || diagnostic.start === void 0) continue;
			const text = diagnosticFile.text;
			const starts = computeLineStarts(text);
			const related = this.relatedInformationOf(ts, diagnostic);
			const tags = tagsOf(diagnostic);
			result.push({
				range: spanRange(starts, text.length, {
					start: diagnostic.start,
					length: diagnostic.length ?? 0
				}),
				severity: severityOf(diagnostic.category),
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
				code: `TS${diagnostic.code}`,
				source: "ts",
				...tags === void 0 ? {} : { tags },
				...related.length === 0 ? {} : { related }
			});
		}
		return result.sort((left, right) => comparePosition(left.range.start, right.range.start) || severityRank$1(left.severity) - severityRank$1(right.severity));
	}
	relatedInformationOf(ts, diagnostic) {
		const related = [];
		for (const information of diagnostic.relatedInformation ?? []) {
			const file = information.file;
			if (file === void 0 || information.start === void 0) continue;
			const starts = computeLineStarts(file.text);
			related.push({
				path: this.absolute(file.fileName),
				range: spanRange(starts, file.text.length, {
					start: information.start,
					length: information.length ?? 0
				}),
				message: ts.flattenDiagnosticMessageText(information.messageText, " ")
			});
		}
		return related;
	}
	/** 把 TS 的「文件名 + TextSpan」转成协议位置；文件内容取不到时返回 undefined（调用方过滤掉）。 */
	locationOf(fileName, span) {
		const range = this.rangeOf(fileName, span);
		return range === void 0 ? void 0 : {
			path: this.absolute(fileName),
			range
		};
	}
	/** TextSpan → 0 基范围；内容来自内存正文、程序快照或磁盘。 */
	rangeOf(fileName, span) {
		const text = this.textOf(fileName);
		if (text === void 0) return void 0;
		return spanRange(this.lineStartsFor(fileName, text), text.length, span);
	}
	lineStartsFor(fileName, text) {
		const key = this.keyOf(fileName);
		const cached = this.lineCache.get(key);
		if (cached !== void 0 && cached.text === text) return cached.starts;
		const starts = computeLineStarts(text);
		if (this.lineCache.size >= MAX_LINE_CACHE_ENTRIES) this.lineCache.clear();
		this.lineCache.set(key, {
			text,
			starts
		});
		return starts;
	}
	/** 取文件内容：内存正文优先，其次是程序里的 SourceFile 快照，最后才读磁盘。 */
	textOf(fileName) {
		const key = this.keyOf(fileName);
		const open = this.openDocuments.get(key);
		if (open !== void 0) return open.content;
		const program = this.service?.getProgram();
		if (program !== void 0) {
			const sourceFile = program.getSourceFile(this.absolute(fileName)) ?? program.getSourceFiles().find((candidate) => this.keyOf(candidate.fileName) === key);
			if (sourceFile !== void 0) return sourceFile.text;
		}
		try {
			return readFileSync(this.absolute(fileName), "utf8");
		} catch {
			return;
		}
	}
	/** 行列 → 偏移；位置超出文件时夹到末尾，不让越界输入把 TS 的 API 弄崩。 */
	offsetIn(fileName, position) {
		const text = this.textOf(fileName) ?? "";
		return offsetAtPosition(text, this.lineStartsFor(fileName, text), position);
	}
	/** 文件是否存在于磁盘，或者是客户端打开的内存文档（rename/编辑只认这两类文件）。 */
	fileIsKnown(fileName) {
		if (this.openDocuments.has(this.keyOf(fileName))) return true;
		try {
			return statSync(fileName).isFile();
		} catch {
			return false;
		}
	}
	/** FileTextChanges[] → 协议工作区编辑；过滤掉没有任何文本替换的文件。 */
	workspaceEditOf(changes) {
		const files = [];
		for (const change of changes) {
			const edits = [];
			for (const textChange of change.textChanges) {
				const range = this.rangeOf(change.fileName, textChange.span);
				if (range === void 0) continue;
				edits.push({
					range,
					newText: textChange.newText
				});
			}
			if (edits.length === 0) continue;
			files.push({
				path: this.absolute(change.fileName),
				edits
			});
		}
		return files.length === 0 ? void 0 : { changes: files };
	}
	/** 规范化成绝对路径（本机分隔符）。 */
	absolute(fileName) {
		return isAbsolute(fileName) ? resolve(fileName) : resolve(this.workspace, fileName);
	}
	/** Map 键：绝对路径，大小写不敏感平台统一小写。 */
	keyOf(fileName) {
		const absolutePath = this.absolute(fileName);
		return this.caseSensitive ? absolutePath : absolutePath.toLowerCase();
	}
	warn(message) {
		try {
			this.options.onLog?.("warn", `[typescript] ${message}`);
		} catch {}
	}
};
/** 用默认参数创建内置 TypeScript provider（管理器只依赖这个工厂与 LanguageProvider 接口）。 */
function createTypeScriptProvider(options) {
	return new TypeScriptLanguageProvider(options);
}
/** NavigationTree → 文档符号（递归）。`starts`/`textLength` 是同一文件的行首表与长度。 */
function convertNavigationTree(node, starts, textLength) {
	const fullSpan = node.spans[0];
	if (fullSpan === void 0) return void 0;
	if (node.text === "") return void 0;
	const nameSpan = node.nameSpan ?? fullSpan;
	const range = spanRange(starts, textLength, fullSpan);
	const selectionRange = spanRange(starts, textLength, nameSpan);
	const children = (node.childItems ?? []).map((child) => convertNavigationTree(child, starts, textLength)).filter((child) => child !== void 0);
	return {
		name: node.text,
		...node.kindModifiers === "" ? {} : { detail: node.kindModifiers },
		kind: symbolKindOf(node.kind),
		range,
		selectionRange,
		...children.length === 0 ? {} : { children }
	};
}
/** 位置的字典序比较（行优先）。 */
function comparePosition(left, right) {
	return left.line !== right.line ? left.line - right.line : left.character - right.character;
}
//#endregion
//#region src/language/settings.ts
/**
* 语言服务的运行期设置。
*
* 优先级与环境变量一致：**环境变量 > 设置文件 > 插件配置 > 默认值**。
* 与补全设置（completion/settings.ts）同样的理由分出两条路：插件配置是应用里能设的那条，
* 环境变量是排查与临时试验用的那条，设置文件是桌面端不重启应用也能改的那条。
*
* 设置文件固定为 `%DSH_HOME%/language.settings.json`，形状：
* `{ "enabled": true, "builtinTypescript": true, "servers": [{ "command": "...", ... }] }`
* 文件不存在、不是 JSON、字段类型不对都只影响出错的那一项，绝不因此让语言服务整体失效。
*/
const DEFAULT_LANGUAGE_SETTINGS = {
	enabled: true,
	builtinTypescript: true,
	servers: []
};
/** 设置文件的固定文件名；与补全设置文件同级。 */
const LANGUAGE_SETTINGS_FILE = "language.settings.json";
/** 设置页写文件时的错误；路由把它映射成 400 而不是 500。 */
var LanguageSettingsWriteError = class extends Error {};
/** 设置文件位置；数据目录未知时返回 undefined。 */
function languageSettingsPath(env = globalThis.process?.env ?? {}) {
	const home = env["DSH_HOME"];
	if (home === void 0 || home === "") return void 0;
	return `${home.replace(/[\\/]+$/, "").replaceAll("\\", "/")}/${LANGUAGE_SETTINGS_FILE}`;
}
/** 从一段可能存在的配置里取 language 桶；字段缺失或类型不对返回空对象。 */
function bucketOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = value;
	const nested = record["language"];
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) return nested;
	if ("enabled" in record || "builtinTypescript" in record || "servers" in record) return record;
	return {};
}
function booleanField(value) {
	return typeof value === "boolean" ? value : void 0;
}
/** 插件配置 / 设置文件给出的设置。 */
function fromLanguageConfig(value) {
	const bucket = bucketOf(value);
	const settings = {};
	const enabled = booleanField(bucket["enabled"]);
	if (enabled !== void 0) settings.enabled = enabled;
	const builtin = booleanField(bucket["builtinTypescript"]);
	if (builtin !== void 0) settings.builtinTypescript = builtin;
	if (Array.isArray(bucket["servers"])) settings.servers = bucket["servers"];
	return settings;
}
/** 环境变量给出的覆盖；空串视为没设。 */
function fromLanguageEnvironment(env) {
	const settings = {};
	const enabled = env["DSH_AIDE_LANGUAGE"];
	if (enabled !== void 0 && enabled !== "") settings.enabled = ![
		"0",
		"off",
		"false",
		"no"
	].includes(enabled.toLowerCase());
	const builtin = env["DSH_AIDE_LANGUAGE_BUILTIN"];
	if (builtin !== void 0 && builtin !== "") settings.builtinTypescript = ![
		"0",
		"off",
		"false",
		"no"
	].includes(builtin.toLowerCase());
	const servers = env["DSH_AIDE_LANGUAGE_SERVERS"];
	if (servers !== void 0 && servers !== "") try {
		const parsed = JSON.parse(servers);
		if (Array.isArray(parsed)) settings.servers = parsed;
	} catch {}
	return settings;
}
/** 合并来源得到生效设置；`file` 传设置文件内容（未知时不传）。 */
function resolveLanguageSettings(config, env = globalThis.process?.env ?? {}, file) {
	return {
		...DEFAULT_LANGUAGE_SETTINGS,
		...fromLanguageConfig(config),
		...fromLanguageConfig(file),
		...fromLanguageEnvironment(env)
	};
}
const FILE_RECHECK_MS = 2e3;
let pluginConfig;
let fileValue;
let fileCheckedAt = 0;
let current = DEFAULT_LANGUAGE_SETTINGS;
function readFileSettings(path) {
	if (path === void 0) return void 0;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function refresh(now, env) {
	const path = languageSettingsPath(env);
	if (now - fileCheckedAt >= FILE_RECHECK_MS) {
		fileValue = readFileSettings(path);
		fileCheckedAt = now;
	}
	current = resolveLanguageSettings(pluginConfig, env, fileValue);
}
/** 插件加载时写入配置；返回当时生效的设置。 */
function setLanguageSettings(config) {
	pluginConfig = config;
	refresh(Date.now(), globalThis.process?.env ?? {});
	return current;
}
/** 取当前生效设置；设置文件按固定周期重读，改完几秒内生效。 */
function languageSettings(now = Date.now(), env = globalThis.process?.env ?? {}) {
	refresh(now, env);
	return current;
}
/**
* 设置页要展示的视图。
*
* `servers` 由调用方传入已发现列表（发现逻辑在 servers.ts，属于宿主侧能力）；设置文件路径与
* 环境变量覆盖一并给出，用户排查「为什么开关不生效」时第一眼能看到优先级更高的来源。
*/
function languageSettingsView(env = globalThis.process?.env ?? {}, servers = []) {
	refresh(Date.now(), env);
	const path = languageSettingsPath(env);
	const view = {
		enabled: current.enabled,
		builtinTypescript: current.builtinTypescript,
		servers: [...servers]
	};
	if (path !== void 0) view.file = path;
	const envEnabled = env["DSH_AIDE_LANGUAGE"];
	const envBuiltin = env["DSH_AIDE_LANGUAGE_BUILTIN"];
	if (envEnabled !== void 0 && envEnabled !== "" || envBuiltin !== void 0 && envBuiltin !== "") view.env = {
		...envEnabled === void 0 || envEnabled === "" ? {} : { enabled: envEnabled },
		...envBuiltin === void 0 || envBuiltin === "" ? {} : { builtinTypescript: envBuiltin }
	};
	return view;
}
function systemIo() {
	return {
		read: (path) => {
			try {
				return JSON.parse(readFileSync(path, "utf8"));
			} catch {
				return;
			}
		},
		write: (path, value) => {
			const separator = path.lastIndexOf("/");
			if (separator > 0) mkdirSync(path.slice(0, separator), { recursive: true });
			const temporary = `${path}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
			renameSync(temporary, path);
		}
	};
}
/**
* 写入语言服务设置并立刻生效。
*
* 只改当前文件里已有的字段：`servers` 这类由用户手写的配置必须原样保留，
* 设置页里的两个开关不该把它们冲掉。
*/
function updateLanguageSettings(patch, env = globalThis.process?.env ?? {}, io = systemIo(), servers = []) {
	const path = languageSettingsPath(env);
	if (path === void 0) throw new LanguageSettingsWriteError("数据目录未知（未设置 DSH_HOME），无法保存语言服务设置");
	const stored = io.read(path);
	const next = { ...bucketOf(typeof stored === "object" && stored !== null && !Array.isArray(stored) ? { ...stored } : {}) };
	if (patch.enabled !== void 0) next["enabled"] = patch.enabled;
	if (patch.builtinTypescript !== void 0) next["builtinTypescript"] = patch.builtinTypescript;
	io.write(path, next);
	fileValue = next;
	fileCheckedAt = Date.now();
	current = resolveLanguageSettings(pluginConfig, env, fileValue);
	return languageSettingsView(env, servers);
}
/** 取用户配置的服务器数组（交给 servers.ts 解析）。 */
function configuredLanguageServers() {
	return languageSettings().servers;
}
//#endregion
//#region src/language/manager.ts
/**
* 一个工作区的语言服务管理器。
*
* 职责只有四件：
*   1. 按语言挑 provider（内置 TypeScript，或按扩展名匹配到的外部 LSP 服务器）；
*   2. 维护客户端打开的文档版本，把 open/change/close 转发给 provider；
*   3. 把诊断收上来，聚合成推送消息（外部服务器主动推、内置服务按防抖调度算）；
*   4. 给路由层提供一跳转/补全/重命名这类请求的统一入口。
*
* provider 一律懒加载：没打开对应语言的文件之前，不加载 TypeScript、也不启动外部服务器。
* 这保证「装了 AIDE 但不用语言服务」的场景没有额外开销。
*/
/** 关闭文档后保留最近一次诊断，问题面板仍然能看到「已关闭文件里曾有错」。 */
const MAX_DIAGNOSTIC_FILES = 500;
/** 单个只读文件（lib.d.ts 之类）的读取上限。 */
const MAX_READ_BYTES = 4194304;
/** 工作区扫描时每算完几个文件推一次进度。 */
const SCAN_STATUS_EVERY = 8;
/** 语言请求失败时给路由层的错误（客户端会显示 message）。 */
var LanguageRequestError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
function keyOf(path) {
	const absolute = resolve(path);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
var LanguageManager = class {
	workspace;
	emit;
	env;
	diagnosticsDelayMs;
	documents = /* @__PURE__ */ new Map();
	diagnostics = /* @__PURE__ */ new Map();
	providers = /* @__PURE__ */ new Set();
	providerByLanguage = /* @__PURE__ */ new Map();
	startedServers = /* @__PURE__ */ new Map();
	/**
	* 正在创建中的 provider。
	*
	* 打开文件与「跳转/悬停」可能同时到达：没有这层锁时两条并发路径会各建一个 TypeScript 语言服务
	* （两份项目程序、双倍内存），外部服务器的 `initialize` 也会被并发触发。按 provider 归类去重。
	*/
	creating = /* @__PURE__ */ new Map();
	diagnosticsTimers = /* @__PURE__ */ new Map();
	discovered;
	scanState;
	scanRunning = false;
	scanAbort;
	lastStatusAt = 0;
	disposed = false;
	constructor(options) {
		this.workspace = resolve(options.workspace);
		this.emit = options.emit ?? (() => {});
		this.env = options.env ?? globalThis.process?.env ?? {};
		this.diagnosticsDelayMs = options.diagnosticsDelayMs ?? 320;
	}
	/** 当前工作区根（绝对路径）。 */
	root() {
		return this.workspace;
	}
	/** 客户端拉取总体信息：哪些语言可服务、服务器状态、扫描进度。 */
	async info() {
		const settings = languageSettings(void 0, this.env);
		if (!settings.enabled) return {
			enabled: false,
			builtin: {
				enabled: false,
				state: "disabled"
			},
			servers: [],
			languages: [],
			...this.scanState === void 0 ? {} : { scan: this.scanState }
		};
		const discovered = await this.discover();
		const servers = [];
		for (const server of discovered.available) {
			const provider = this.startedServers.get(server.id);
			servers.push({
				id: server.id,
				name: server.name,
				languages: server.languages,
				state: provider === void 0 ? "idle" : "running",
				command: [server.executable, ...server.args].join(" ")
			});
		}
		for (const server of discovered.missing) servers.push({
			id: server.id,
			name: server.name,
			languages: server.languages,
			state: "missing",
			detail: "未找到可执行文件",
			command: server.command
		});
		const builtinProvider = settings.builtinTypescript ? this.lookupProvider("typescript") : void 0;
		const builtin = settings.builtinTypescript ? {
			enabled: true,
			state: "ready",
			...builtinProvider?.info.version === void 0 ? {} : { version: builtinProvider.info.version }
		} : {
			enabled: false,
			state: "disabled"
		};
		const languages = /* @__PURE__ */ new Set();
		if (settings.builtinTypescript) {
			languages.add("typescript");
			languages.add("javascript");
		}
		for (const server of discovered.available) for (const language of server.languages) languages.add(language);
		return {
			enabled: true,
			builtin,
			servers,
			languages: [...languages],
			...this.scanState === void 0 ? {} : { scan: this.scanState }
		};
	}
	/** 客户端文档同步（open/change/close）。 */
	async sync(message) {
		if (this.disposed) return;
		const absolute = resolve(message.path);
		if (!inside(this.workspace, absolute)) throw new LanguageRequestError("path-outside", "language document is outside the workspace", 403);
		const key = keyOf(absolute);
		if (message.kind === "close") {
			const document = this.documents.get(key);
			this.documents.delete(key);
			this.clearDiagnosticsTimer(key);
			if (document !== void 0) this.lookupProvider(document.languageId)?.closeDocument(document.path);
			return;
		}
		const existing = this.documents.get(key);
		if (existing !== void 0 && existing.version > message.version) return;
		const document = {
			path: absolute,
			languageId: message.languageId,
			version: message.version,
			content: message.content
		};
		this.documents.set(key, document);
		const provider = await this.providerForLanguage(document.languageId);
		if (provider === void 0) return;
		if (message.kind === "open") provider.openDocument(document);
		else provider.changeDocument(document);
		this.scheduleBuiltinDiagnostics(document, provider);
	}
	async definition(path, position, signal) {
		return this.withProvider(path, (provider, document) => provider.definition?.(document.path, position, signal) ?? Promise.resolve([]), []);
	}
	async hover(path, position, signal) {
		return this.withProvider(path, async (provider, document) => provider.hover === void 0 ? null : await provider.hover(document.path, position, signal), null);
	}
	async references(path, position, signal) {
		return this.withProvider(path, (provider, document) => provider.references?.(document.path, position, signal) ?? Promise.resolve([]), []);
	}
	async rename(path, position, newName, signal) {
		if (newName.trim() === "") return {
			canRename: false,
			message: "新名称不能为空"
		};
		return this.withProvider(path, async (provider, document) => {
			if (provider.rename === void 0) return {
				canRename: false,
				message: "当前语言服务不支持重命名"
			};
			return await provider.rename(document.path, position, newName, signal);
		}, {
			canRename: false,
			message: "当前语言服务不支持重命名"
		});
	}
	async documentSymbols(path, signal) {
		return this.withProvider(path, (provider, document) => provider.documentSymbols?.(document.path, signal) ?? Promise.resolve([]), []);
	}
	async workspaceSymbols(query, limit = 200, signal) {
		const trimmed = query.trim();
		if (trimmed === "") return [];
		const providers = [];
		const builtin = this.lookupProvider("typescript");
		if (builtin !== void 0) providers.push(builtin);
		for (const provider of this.startedServers.values()) if (provider.workspaceSymbols !== void 0 && !providers.includes(provider)) providers.push(provider);
		if (providers.length === 0) return [];
		const results = await Promise.all(providers.map((provider) => provider.workspaceSymbols?.(trimmed, limit, signal).catch((error) => {
			this.log("warn", `工作区符号查询失败：${errorMessage(error)}`);
			return [];
		}) ?? Promise.resolve([])));
		const seen = /* @__PURE__ */ new Set();
		const merged = [];
		for (const list of results) for (const symbol of list) {
			const key = `${symbol.path}\0${symbol.range.start.line}:${symbol.range.start.character}\0${symbol.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(symbol);
			if (merged.length >= limit) return merged;
		}
		return merged;
	}
	async completion(path, position, triggerCharacter, signal) {
		return this.withProvider(path, async (provider, document) => {
			if (provider.completion === void 0) return null;
			return await provider.completion(document.path, position, triggerCharacter, signal);
		}, null);
	}
	async signatureHelp(path, position, signal) {
		return this.withProvider(path, async (provider, document) => {
			if (provider.signatureHelp === void 0) return null;
			return await provider.signatureHelp(document.path, position, signal);
		}, null);
	}
	async codeActions(path, range, diagnostics, signal) {
		return this.withProvider(path, (provider, document) => provider.codeActions?.(document.path, range, diagnostics, signal) ?? Promise.resolve([]), []);
	}
	/** 取某文件当前已知诊断（快速修复的 codeAction 请求会用到）。 */
	diagnosticsOf(path) {
		return this.diagnostics.get(keyOf(path))?.items ?? [];
	}
	/**
	* 启动一次工作区级诊断扫描（目前只有内置 TypeScript 支持）。
	* 返回 undefined 表示当前没有可扫描的 provider。
	*/
	async scan(signal) {
		if (this.scanRunning) return this.scanState;
		const provider = await this.providerForLanguage("typescript");
		if (provider?.workspaceDiagnostics === void 0) return void 0;
		const controller = new AbortController();
		const forwardAbort = () => controller.abort();
		if (signal?.aborted === true) controller.abort();
		signal?.addEventListener("abort", forwardAbort, { once: true });
		this.scanAbort = controller;
		this.scanRunning = true;
		this.scanState = {
			running: true,
			checked: 0,
			total: 0,
			errors: 0,
			warnings: 0
		};
		this.emitStatus(true);
		let errors = 0, warnings = 0, checked = 0;
		try {
			const result = await provider.workspaceDiagnostics((path, diagnostics) => {
				this.recordDiagnostics(path, diagnostics);
				const counts = diagnosticCounts(diagnostics);
				errors += counts.errors;
				warnings += counts.warnings;
				checked++;
				this.scanState = {
					running: true,
					checked,
					total: this.scanState?.total ?? 0,
					errors,
					warnings
				};
				if (checked % SCAN_STATUS_EVERY === 0) this.emitStatus(true);
			}, controller.signal, (total) => {
				this.scanState = {
					running: true,
					checked: this.scanState?.checked ?? 0,
					total,
					errors,
					warnings
				};
				this.emitStatus(true);
			});
			const total = Math.max(this.scanState?.total ?? 0, result.checked);
			this.scanState = {
				running: false,
				checked: result.checked,
				total,
				errors: result.errors,
				warnings: result.warnings,
				...result.error === void 0 ? {} : { error: result.error }
			};
			if (controller.signal.aborted) this.log("info", `工作区扫描已取消（已检查 ${result.checked} 个文件）`);
			else if (result.error !== void 0) this.log("warn", `工作区扫描未完成：${result.error}`);
		} catch (error) {
			this.log("warn", `工作区诊断扫描失败：${errorMessage(error)}`);
			this.scanState = {
				running: false,
				checked,
				total: Math.max(this.scanState?.total ?? 0, checked),
				errors,
				warnings
			};
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
			if (this.scanAbort === controller) this.scanAbort = void 0;
			this.scanRunning = false;
			this.emitStatus(true);
		}
		return this.scanState;
	}
	/** 取消正在运行的工作区扫描；worker 会被 terminate，已产出的结果保留。 */
	cancelScan() {
		if (!this.scanRunning) return false;
		this.scanAbort?.abort();
		return true;
	}
	/** 读取只读文件（跳转目标可能在 node_modules / TypeScript lib 里）。 */
	async readFile(path, languageId) {
		const absolute = resolve(path);
		const resolvedLanguage = languageId ?? languageIdForPath(absolute) ?? "";
		if (inside(this.workspace, absolute)) try {
			const stat = statSync(absolute);
			if (!stat.isFile() || stat.size > MAX_READ_BYTES) return void 0;
			return {
				path: absolute,
				content: readFileSync(absolute, "utf8"),
				languageId: resolvedLanguage
			};
		} catch {
			return;
		}
		const provider = resolvedLanguage === "" ? void 0 : this.lookupProvider(resolvedLanguage);
		if (provider?.readFile === void 0) return void 0;
		try {
			const content = await provider.readFile(absolute);
			if (content === void 0 || content.length > MAX_READ_BYTES) return void 0;
			return {
				path: absolute,
				content,
				languageId: resolvedLanguage
			};
		} catch (error) {
			this.log("warn", `读取语言服务文件失败：${errorMessage(error)}`);
			return;
		}
	}
	/**
	* 把一组编辑写到磁盘（只用于没有打开模型的干净文件；打开中的文件由编辑器自己应用）。
	* 返回实际写入的文件，客户端据此刷新标签。
	*/
	async applyEdits(edit) {
		const written = [];
		for (const change of edit.changes) {
			const absolute = resolve(change.path);
			if (!inside(this.workspace, absolute)) continue;
			try {
				const next = applyTextEdits(readFileSync(absolute, "utf8"), change.edits);
				const temporary = `${absolute}.dvw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(temporary, next, "utf8");
				renameSync(temporary, absolute);
				written.push(absolute);
			} catch (error) {
				this.log("warn", `写入语言服务编辑失败 ${absolute}：${errorMessage(error)}`);
			}
		}
		return written;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.scanAbort?.abort();
		this.scanAbort = void 0;
		for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer);
		this.diagnosticsTimers.clear();
		for (const provider of this.providers) try {
			Promise.resolve(provider.dispose()).catch(() => {});
		} catch {}
		this.providers.clear();
		this.providerByLanguage.clear();
		this.startedServers.clear();
		this.documents.clear();
	}
	async discover() {
		if (this.discovered === void 0) this.discovered = discoverServers(this.env, { language: { servers: configuredLanguageServers() } });
		return this.discovered;
	}
	/** 不触发加载：只查已经建好的 provider。 */
	lookupProvider(languageId) {
		return this.providerByLanguage.get(languageId) ?? void 0;
	}
	async providerForLanguage(languageId) {
		if (this.disposed) return void 0;
		const cached = this.providerByLanguage.get(languageId);
		if (cached !== void 0) return cached ?? void 0;
		const settings = languageSettings(void 0, this.env);
		if (!settings.enabled) return void 0;
		const key = isTypeScriptLanguage(languageId) ? "builtin-typescript" : `external:${languageId}`;
		const pending = this.creating.get(key);
		if (pending !== void 0) return pending;
		const promise = this.createProvider(languageId, settings);
		this.creating.set(key, promise);
		try {
			return await promise;
		} finally {
			this.creating.delete(key);
		}
	}
	async createProvider(languageId, settings) {
		const cached = this.providerByLanguage.get(languageId);
		if (cached !== void 0) return cached ?? void 0;
		if (this.disposed) return void 0;
		if (isTypeScriptLanguage(languageId)) {
			if (!settings.builtinTypescript) {
				this.providerByLanguage.set(languageId, null);
				return;
			}
			const provider = this.registerProvider(createTypeScriptProvider({
				workspace: this.workspace,
				onDiagnostics: (path, diagnostics) => this.recordDiagnostics(path, diagnostics),
				onLog: (level, message) => this.log(level, message),
				onStateChange: () => this.emitStatus(false)
			}));
			for (const language of provider.info.languages) this.providerByLanguage.set(language, provider);
			this.emitStatus(true);
			return provider;
		}
		const server = serverForLanguage(languageId, (await this.discover()).available);
		if (server === void 0) {
			this.providerByLanguage.set(languageId, null);
			return;
		}
		const running = this.startedServers.get(server.id);
		if (running !== void 0) {
			for (const language of running.info.languages) this.providerByLanguage.set(language, running);
			return running;
		}
		try {
			const provider = this.registerProvider(createExternalProvider({
				workspace: this.workspace,
				server,
				env: this.env,
				onDiagnostics: (path, diagnostics) => this.recordDiagnostics(path, diagnostics),
				onLog: (level, message) => this.log(level, message),
				onStateChange: () => this.emitStatus(false)
			}));
			this.startedServers.set(server.id, provider);
			for (const language of provider.info.languages) this.providerByLanguage.set(language, provider);
			this.emitStatus(true);
			return provider;
		} catch (error) {
			this.log("error", `启动语言服务器 ${server.name} 失败：${errorMessage(error)}`);
			this.providerByLanguage.set(languageId, null);
			return;
		}
	}
	registerProvider(provider) {
		this.providers.add(provider);
		for (const document of this.documents.values()) if (provider.info.languages.includes(document.languageId)) try {
			provider.openDocument(document);
		} catch (error) {
			this.log("warn", `同步已打开文档失败：${errorMessage(error)}`);
		}
		return provider;
	}
	scheduleBuiltinDiagnostics(document, provider) {
		if (provider.diagnostics === void 0) return;
		const key = keyOf(document.path);
		this.clearDiagnosticsTimer(key);
		const timer = setTimeout(() => {
			this.diagnosticsTimers.delete(key);
			const latest = this.documents.get(key);
			if (latest === void 0 || latest.version !== document.version) return;
			provider.diagnostics?.(latest.path).then((diagnostics) => {
				if (this.disposed) return;
				this.recordDiagnostics(latest.path, diagnostics);
			}).catch((error) => this.log("warn", `诊断计算失败：${errorMessage(error)}`));
		}, this.diagnosticsDelayMs);
		this.diagnosticsTimers.set(key, timer);
	}
	clearDiagnosticsTimer(key) {
		const timer = this.diagnosticsTimers.get(key);
		if (timer !== void 0) {
			clearTimeout(timer);
			this.diagnosticsTimers.delete(key);
		}
	}
	recordDiagnostics(path, diagnostics) {
		if (this.disposed) return;
		const absolute = resolve(path);
		const key = keyOf(absolute);
		this.diagnostics.set(key, {
			path: absolute,
			items: diagnostics
		});
		if (this.diagnostics.size > MAX_DIAGNOSTIC_FILES) for (const [candidate, value] of this.diagnostics) {
			if (this.documents.has(candidate)) continue;
			if (value.items.length > 0) continue;
			this.diagnostics.delete(candidate);
			if (this.diagnostics.size <= MAX_DIAGNOSTIC_FILES) break;
		}
		this.emit({
			type: "diagnostics",
			path: absolute,
			diagnostics
		});
	}
	async withProvider(path, run, fallback) {
		if (this.disposed) return fallback;
		const absolute = resolve(path);
		const document = await this.ensureDocument(absolute);
		if (document === void 0) return fallback;
		const provider = await this.providerForLanguage(document.languageId);
		if (provider === void 0) return fallback;
		try {
			return await run(provider, document);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return fallback;
			this.log("warn", `语言请求失败：${errorMessage(error)}`);
			return fallback;
		}
	}
	/** 请求可能落在没打开的跳转目标上：按需读盘并补一次 open。 */
	async ensureDocument(absolute) {
		const key = keyOf(absolute);
		const existing = this.documents.get(key);
		if (existing !== void 0) return existing;
		let content;
		try {
			const stat = statSync(absolute);
			if (!stat.isFile() || stat.size > MAX_READ_BYTES) return void 0;
			content = readFileSync(absolute, "utf8");
		} catch {
			return;
		}
		const languageId = languageIdForPath(absolute);
		if (languageId === void 0) return void 0;
		const document = {
			path: absolute,
			languageId,
			version: 1,
			content
		};
		this.documents.set(key, document);
		const provider = await this.providerForLanguage(languageId);
		if (provider !== void 0) try {
			provider.openDocument(document);
		} catch (error) {
			this.log("warn", `同步按需文档失败：${errorMessage(error)}`);
		}
		return document;
	}
	emitStatus(force) {
		const now = Date.now();
		if (!force && now - this.lastStatusAt < 200) return;
		this.lastStatusAt = now;
		this.info().then((info) => {
			if (this.disposed) return;
			this.emit({
				type: "status",
				servers: info.servers,
				builtin: info.builtin,
				...info.scan === void 0 ? {} : { scan: info.scan }
			});
		}).catch(() => {});
	}
	log(level, message) {
		if (this.disposed) return;
		this.emit({
			type: "log",
			level,
			message
		});
	}
};
/** 按范围从后往前应用替换，保证前面的编辑不会移动后面编辑的坐标。 */
function applyTextEdits(text, edits) {
	const lineStarts = lineOffsets(text);
	const offsetOf = (position) => {
		const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
		const start = lineStarts[line] ?? 0;
		return Math.min(text.length, start + Math.max(0, position.character));
	};
	const ordered = [...edits].sort((left, right) => {
		const a = offsetOf(left.range.start);
		return offsetOf(right.range.start) - a;
	});
	let next = text;
	for (const edit of ordered) {
		const start = offsetOf(edit.range.start);
		const end = offsetOf(edit.range.end);
		if (start > end) throw new LanguageRequestError("invalid-edit", "edit range is reversed");
		next = `${next.slice(0, start)}${edit.newText}${next.slice(end)}`;
	}
	return next;
}
/** 每行起始偏移；空文本也返回 [0]，让位置 0:0 可用。 */
function lineOffsets(text) {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
	return starts;
}
//#endregion
//#region src/language/host.ts
/**
* 宿主侧语言服务的「按工作区路由」。
*
* 一个 DSH 进程里可能有多个会话、多个工作区；每个工作区一份 LanguageManager（各自的项目程序、
* 各自的外部服务器进程）。WebSocket 连接按工作区归组，诊断/状态推送只发给同一个工作区的客户端。
*
* 这个模块同时是设置页的服务器发现入口：设置页没有会话，不能走「解析工作区」那条路。
*/
function workspaceKey(workspace) {
	const absolute = resolve(workspace);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
/** 把发现结果摊平成设置页/状态栏用的服务器列表。 */
function serverInfos(discovered) {
	const infos = [];
	for (const server of discovered.available) infos.push({
		id: server.id,
		name: server.name,
		languages: server.languages,
		state: "idle",
		command: [server.executable, ...server.args].join(" ")
	});
	for (const server of discovered.missing) infos.push({
		id: server.id,
		name: server.name,
		languages: server.languages,
		state: "missing",
		detail: "未找到可执行文件",
		command: server.command
	});
	return infos;
}
var LanguageHost = class {
	env;
	entries = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(env = globalThis.process?.env ?? {}) {
		this.env = env;
	}
	/** 取（或创建）某工作区的管理器。 */
	managerFor(workspace) {
		const key = workspaceKey(workspace);
		const existing = this.entries.get(key);
		if (existing !== void 0) return existing.manager;
		const entry = {
			manager: void 0,
			clients: /* @__PURE__ */ new Set()
		};
		const manager = new LanguageManager({
			workspace,
			emit: (message) => {
				const data = JSON.stringify(message);
				for (const client of entry.clients) if (client.readyState === 1) try {
					client.send(data);
				} catch {}
			},
			env: this.env
		});
		entry.manager = manager;
		this.entries.set(key, entry);
		return manager;
	}
	/** 工作台语言 WebSocket 接入；立刻回一次状态，客户端不用额外轮询。 */
	attach(workspace, client) {
		const manager = this.managerFor(workspace);
		const entry = this.entries.get(workspaceKey(workspace));
		if (entry === void 0) return;
		entry.clients.add(client);
		manager.info().then((info) => {
			if (client.readyState !== 1) return;
			const message = {
				type: "status",
				servers: info.servers,
				builtin: info.builtin,
				...info.scan === void 0 ? {} : { scan: info.scan }
			};
			try {
				client.send(JSON.stringify(message));
			} catch {}
		}).catch(() => {});
	}
	detach(workspace, client) {
		this.entries.get(workspaceKey(workspace))?.clients.delete(client);
	}
	/** 设置页用：已发现/未安装的服务器（不依赖工作区）。 */
	servers(env = this.env) {
		try {
			return serverInfos(discoverServers(env, { language: { servers: configuredLanguageServers() } }));
		} catch {
			return [];
		}
	}
	/** 设置页用：语言服务设置 + 服务器发现结果。 */
	settingsView(env = this.env) {
		return languageSettingsView(env, this.servers(env));
	}
	/** 设置改变后重建全部工作区记录：关掉旧服务器，客户端重连后拿到新的能力集合。 */
	reset() {
		for (const entry of this.entries.values()) {
			entry.manager.dispose();
			for (const client of entry.clients) try {
				client.close(1012, "language settings changed");
			} catch {}
		}
		this.entries.clear();
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.reset();
	}
};
const hosts = /* @__PURE__ */ new WeakMap();
/** 每个插件应用一份（ctx 的弱引用键）；避免把状态挂到全局单例上导致测试之间串。 */
function languageHostFor(owner) {
	const existing = hosts.get(owner);
	if (existing !== void 0) return existing;
	const host = new LanguageHost();
	hosts.set(owner, host);
	return host;
}
//#endregion
//#region src/language/api.ts
/** 同步正文的上限：body 本身限 2 MiB，这里留出 JSON 转义余量后给一个更明确的错误。 */
const MAX_SYNC_CONTENT = 1572864;
function objectField(value, what) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkbenchError("invalid-argument", `${what} must be an object`);
	return value;
}
function numberValue(value, what) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new WorkbenchError("invalid-argument", `${what} must be a finite number`);
	return value;
}
function nonNegativeInteger(value, what) {
	const number = numberValue(value, what);
	if (!Number.isInteger(number) || number < 0) throw new WorkbenchError("invalid-argument", `${what} must be a non-negative integer`);
	return number;
}
function positionValue(value, what) {
	const record = objectField(value, what);
	return {
		line: nonNegativeInteger(record["line"], `${what}.line`),
		character: nonNegativeInteger(record["character"], `${what}.character`)
	};
}
function rangeValue(value, what) {
	const record = objectField(value, what);
	return {
		start: positionValue(record["start"], `${what}.start`),
		end: positionValue(record["end"], `${what}.end`)
	};
}
function workspaceEditValue(value) {
	const record = objectField(value, "edit");
	if (!Array.isArray(record["changes"])) throw new WorkbenchError("invalid-argument", "edit.changes must be an array");
	if (record["changes"].length > 200) throw new WorkbenchError("invalid-argument", "too many files in edit");
	return { changes: record["changes"].map((entry, index) => {
		const change = objectField(entry, `edit.changes[${index}]`);
		const path = change["path"];
		if (typeof path !== "string" || path === "") throw new WorkbenchError("invalid-argument", "edit path must be a non-empty string");
		if (!Array.isArray(change["edits"]) || change["edits"].length > 5e3) throw new WorkbenchError("invalid-argument", "edit list is invalid or too large");
		return {
			path,
			edits: change["edits"].map((rawEdit, editIndex) => {
				const edit = objectField(rawEdit, `edit.changes[${index}].edits[${editIndex}]`);
				const newText = edit["newText"];
				if (typeof newText !== "string") throw new WorkbenchError("invalid-argument", "edit newText must be a string");
				return {
					range: rangeValue(edit["range"], "edit range"),
					newText
				};
			})
		};
	}) };
}
function diagnosticsOf(body) {
	const value = body["diagnostics"];
	if (!Array.isArray(value)) return [];
	const result = [];
	for (const entry of value) try {
		const record = objectField(entry, "diagnostic");
		const message = record["message"];
		const severity = record["severity"];
		if (typeof message !== "string") continue;
		if (severity !== "error" && severity !== "warning" && severity !== "info" && severity !== "hint") continue;
		const code = typeof record["code"] === "string" || typeof record["code"] === "number" ? String(record["code"]) : void 0;
		result.push({
			range: rangeValue(record["range"], "diagnostic.range"),
			severity,
			message,
			...code === void 0 ? {} : { code }
		});
	} catch {}
	return result;
}
/**
* 语言服务方法分发。
*
* `cwd` 由 api.ts 的会话解析给出；这里不再碰会话/工作目录，便于单测直接喂一个 cwd。
*/
async function dispatchLanguage(ctx, method, body, cwd, signal) {
	const manager = languageHostFor(ctx).managerFor(cwd);
	const pathField = () => {
		const value = body["path"];
		if (typeof value !== "string" || value === "") throw new WorkbenchError("invalid-argument", "path must be a non-empty string");
		return value;
	};
	try {
		switch (method) {
			case "language.info": return await manager.info();
			case "language.sync": {
				const kind = body["kind"];
				if (kind !== "open" && kind !== "change" && kind !== "close") throw new WorkbenchError("invalid-argument", "kind must be open, change or close");
				const languageId = body["languageId"];
				if (typeof languageId !== "string" || languageId === "") throw new WorkbenchError("invalid-argument", "languageId must be a non-empty string");
				const version = nonNegativeInteger(body["version"], "version");
				const content = body["content"];
				if (typeof content !== "string") throw new WorkbenchError("invalid-argument", "content must be a string");
				if (content.length > MAX_SYNC_CONTENT) throw new WorkbenchError("too-large", "document is too large for language service", 413);
				await manager.sync({
					kind,
					path: pathField(),
					languageId,
					version,
					content
				});
				return { ok: true };
			}
			case "language.definition": return await manager.definition(pathField(), positionValue(body["position"], "position"), signal);
			case "language.hover": return await manager.hover(pathField(), positionValue(body["position"], "position"), signal);
			case "language.references": return await manager.references(pathField(), positionValue(body["position"], "position"), signal);
			case "language.rename": {
				const newName = body["newName"];
				if (typeof newName !== "string" || newName.trim() === "") throw new WorkbenchError("invalid-argument", "newName must be a non-empty string");
				return await manager.rename(pathField(), positionValue(body["position"], "position"), newName, signal);
			}
			case "language.documentSymbols": return await manager.documentSymbols(pathField(), signal);
			case "language.workspaceSymbols": {
				const query = body["query"];
				if (typeof query !== "string") throw new WorkbenchError("invalid-argument", "query must be a string");
				const limit = body["limit"] === void 0 ? 200 : nonNegativeInteger(body["limit"], "limit");
				return await manager.workspaceSymbols(query, Math.min(Math.max(limit, 1), 500), signal);
			}
			case "language.completion": {
				const trigger = body["triggerCharacter"];
				return await manager.completion(pathField(), positionValue(body["position"], "position"), typeof trigger === "string" ? trigger : void 0, signal);
			}
			case "language.signatureHelp": return await manager.signatureHelp(pathField(), positionValue(body["position"], "position"), signal);
			case "language.codeActions": {
				const path = pathField();
				const range = rangeValue(body["range"], "range");
				const diagnostics = diagnosticsOf(body);
				return await manager.codeActions(path, range, diagnostics.length > 0 ? diagnostics : manager.diagnosticsOf(path), signal);
			}
			case "language.scan": {
				const state = await manager.scan(signal);
				return {
					supported: state !== void 0,
					...state === void 0 ? {} : { state }
				};
			}
			case "language.scanCancel": return { cancelled: manager.cancelScan() };
			case "language.read": {
				const file = await manager.readFile(pathField(), typeof body["languageId"] === "string" ? body["languageId"] : void 0);
				if (file === void 0) throw new WorkbenchError("not-found", "file is not available to the language service", 404);
				return file;
			}
			case "language.applyEdit": return { written: await manager.applyEdits(workspaceEditValue(body["edit"])) };
			default: throw new WorkbenchError("not-found", `unknown language API method ${method}`, 404);
		}
	} catch (error) {
		if (error instanceof WorkbenchError) throw error;
		if (error instanceof LanguageRequestError) throw new WorkbenchError(error.code, error.message, error.status);
		throw new WorkbenchError("language-failed", error instanceof Error ? error.message : String(error), 500);
	}
}
//#endregion
//#region src/inlineEdit.ts
/** prompt 各段的字符上限：超过就截断，避免把整文件塞进上下文。 */
const INLINE_EDIT_LIMITS = {
	selection: 2e4,
	surrounding: 8e3,
	instruction: 2e3
};
/** 输出上限：编辑整段函数通常够用，再大就说明模型在写解释或整文件。 */
const INLINE_EDIT_MAX_TOKENS = 4096;
/** 模型调用超时；超时按失败处理，客户端可以重新发起。 */
const INLINE_EDIT_TIMEOUT_MS = 12e4;
/** 截断到上限，保留头尾（截中间会丢掉正在改的那一段）。 */
function clip(value, limit) {
	if (value.length <= limit) return value;
	const head = Math.ceil(limit * .6);
	return `${value.slice(0, head)}\n…（已截断 ${value.length - limit} 字符）…\n${value.slice(-(limit - head))}`;
}
/**
* 构造 prompt。
*
* 明确要求「只输出替换文本」比依赖模型自觉更可靠；同时给出语言与文件路径，模型才会按该语言的
* 缩进与惯用写法生成，而不是把 JavaScript 片段写进 Python 文件。
*/
function buildInlineEditPrompt(input) {
	const instruction = clip(input.instruction.trim(), INLINE_EDIT_LIMITS.instruction);
	const selection = clip(input.selectionText, INLINE_EDIT_LIMITS.selection);
	const before = clip(input.before, INLINE_EDIT_LIMITS.surrounding);
	const after = clip(input.after, INLINE_EDIT_LIMITS.surrounding);
	return [
		"你在一个代码编辑器里工作。根据用户要求改写下面「选中的代码」，只输出改写后的代码本身。",
		"规则：不要输出 Markdown 围栏；不要解释、不要复述原代码；保持原文件的缩进风格；输出必须是可直接替换选中内容的完整代码。",
		"",
		`文件：${input.filePath}`,
		`语言：${input.language}`,
		"",
		"【选中内容之前】",
		before === "" ? "（文件开头）" : before,
		"",
		"【选中的代码】",
		selection,
		"",
		"【选中内容之后】",
		after === "" ? "（文件结尾）" : after,
		"",
		"【用户要求】",
		instruction
	].join("\n");
}
/** 去掉代码围栏与解释性前后缀；CRLF 统一成 LF（Monaco 的模型内容是 LF）。 */
function sanitizeInlineEditText(raw) {
	let text = raw.replace(/\r\n/g, "\n").trim();
	const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
	if (fenced !== null) text = (fenced[1] ?? "").trim();
	else if (text.startsWith("```")) text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
	return text;
}
/** 请求体校验：字段必须是字符串；超长请求直接拒绝，避免把几 MB 文本喂进模型。 */
function readInlineEditInput(body) {
	const field = (name) => {
		const value = body[name];
		if (typeof value !== "string") throw new WorkbenchError("invalid-argument", `${name} must be a string`, 400);
		return value;
	};
	const input = {
		filePath: field("filePath"),
		language: field("language"),
		instruction: field("instruction"),
		selectionText: field("selectionText"),
		before: field("before"),
		after: field("after")
	};
	if (input.instruction.length > 8e3) throw new WorkbenchError("invalid-argument", "instruction is too long", 400);
	if (input.selectionText.length > 2e5) throw new WorkbenchError("invalid-argument", "selection is too long", 400);
	return input;
}
/**
* 调用模型完成一次编辑。
*
* 模型选择：优先用补全设置里显式配置的路由（用户可能把补全指到更快/更便宜的模型），
* 否则用 DSH 的当前默认模型 —— 编辑是重任务，默认模型更合适。
*/
async function runInlineEdit(ctx, sessionId, input, signal) {
	if (input.selectionText.trim() === "") throw new WorkbenchError("invalid-argument", "selection is empty", 400);
	if (input.instruction.trim() === "") throw new WorkbenchError("invalid-argument", "instruction is empty", 400);
	const llm = ctx.get("llm");
	const defaultModel = ctx.get("agentDefaultModel");
	if (llm === void 0) throw new WorkbenchError("ai-unavailable", "DSH 模型服务不可用", 503);
	let provider;
	let model;
	const selection = defaultModel?.currentSelection();
	if (selection !== void 0) {
		provider = selection.provider;
		model = selection.model;
	} else {
		const configured = completionSettings().route;
		if (configured === void 0) throw new WorkbenchError("ai-unavailable", "DSH 没有可用的默认模型", 503);
		provider = configured.provider;
		model = configured.model;
	}
	const prompt = buildInlineEditPrompt(input);
	const cleaned = sanitizeInlineEditText(await collectStream(llm, {
		provider,
		model,
		...sessionId === "" ? {} : { sessionId },
		temperature: .2,
		maxTokens: INLINE_EDIT_MAX_TOKENS,
		messages: [{
			role: "user",
			content: prompt
		}],
		...signal === void 0 ? {} : { signal }
	}));
	if (cleaned === "") throw new WorkbenchError("ai-empty", "模型没有返回可用的修改", 502);
	return {
		text: cleaned,
		model: `${provider}/${model}`
	};
}
/** 与补全相同的调用顺序：prepared 入口优先，不可用时退回服务级 stream。 */
async function collectStream(llm, request) {
	const timeout = AbortSignal.timeout(INLINE_EDIT_TIMEOUT_MS);
	const signal = request.signal === void 0 ? timeout : AbortSignal.any([request.signal, timeout]);
	let stream;
	try {
		const prepared = await llm.prepareCall({
			provider: request.provider,
			model: request.model,
			...request.sessionId === void 0 ? {} : { sessionId: request.sessionId },
			temperature: request.temperature,
			maxTokens: request.maxTokens
		}, signal);
		stream = prepared.stream({
			...request,
			...prepared.config,
			signal
		});
	} catch (error) {
		console.warn("[dsh-inline-edit] prepared 入口不可用，改用直接 stream：", error instanceof Error ? error.message : String(error));
		stream = llm.stream({
			...request,
			signal
		});
	}
	let text = "";
	for await (const chunk of stream) {
		if (signal.aborted) throw new WorkbenchError("ai-aborted", "模型调用已取消", 499);
		if (chunk.type === "text-delta" && typeof chunk.text === "string") {
			text += chunk.text;
			continue;
		}
		if (chunk.type === "finish") {
			const kind = chunk.reason?.kind;
			if (kind === "error") {
				const failure = chunk.reason?.failure;
				const parts = [
					failure?.message ?? "unknown error",
					failure?.code,
					failure?.status === void 0 ? void 0 : `status ${failure.status}`
				].filter((part) => part !== void 0).map((part) => String(part));
				throw new WorkbenchError("ai-failed", `模型调用失败（${request.provider}/${request.model}）：${parts.join(" · ")}`, 502);
			}
			if (kind === "aborted") throw new WorkbenchError("ai-aborted", "模型调用已取消", 499);
			break;
		}
	}
	return text;
}
//#endregion
//#region src/review.ts
/**
* 工作区改动审查与检查点。
*
* 职责边界：本模块只回答「磁盘上现在和上次见过的时候相比，改了什么」以及「怎么把这些改动退回去」。
* 它不判断改动来自 DSH Agent 还是用户手改 —— 两者都写同一批文件，宿主没有可信的来源标注，
* 与其猜，不如把语义说清楚：这里是**工作区改动**，不是「Agent 改动」。
*
* 基线来源有两层：
*   - 工作台读/存过的文件：进程内记住内容（打开过的文件都在这一层，diff 最精确）；
*   - 没读过的受版本控制文件：退回 `git show HEAD:<path>`（改动多来自 agent 时，这一层覆盖最广）。
* 两层都没有（新文件、无 git）时返回空基线，客户端显示为新增文件而不是「无法对比」。
*
* 检查点写在 `.dsh-workbench/checkpoints.json`（该目录自带 `*` 的 .gitignore）：
* 回滚前自动把当前状态再存一份，回滚本身因此可撤销。
*/
/** 基线内存表的上限：工作台打开过的文件通常远小于它，超出按最旧淘汰。 */
const BASELINE_LIMIT = 300;
/** 单个文件基线/检查点内容的字符上限；再大就不进内存、也不进检查点。 */
const FILE_MAX_CHARS = 1e6;
/** 一次 `review.list` 为了判断「已审查」最多读多少字符；超预算的文件标记为未确认。 */
const REVIEW_READ_BUDGET = 16e6;
/** 检查点保留条数与总字符上限（JSON 落盘，太大会拖慢每一次建立检查点）。 */
const CHECKPOINT_LIMIT = 20;
const CHECKPOINT_TOTAL_CHARS = 8e6;
/** 整个检查点库的上限：20 个满额检查点会到 160MB，必须按总量再收一次。 */
const CHECKPOINTS_STORE_CHARS = 16e6;
const CHECKPOINT_DIR = ".dsh-workbench";
const CHECKPOINT_FILE = "checkpoints.json";
function checkpointChars(checkpoint) {
	return checkpoint.entries.reduce((total, entry) => total + (entry.content?.length ?? 0), 0);
}
const baselines = /* @__PURE__ */ new Map();
/** 用户已确认的删除：文件已不在磁盘上，没有内容可作基线，只能单独记一笔。 */
const confirmedDeletes = /* @__PURE__ */ new Set();
function baselineKey(cwd, path) {
	return `${normalize(cwd)}\0${path}`;
}
/** 记住一个文件的当前内容，作为下一次改动的对比基线。 */
function rememberBaseline(cwd, path, content) {
	if (content.length > FILE_MAX_CHARS) return;
	const key = baselineKey(cwd, path);
	baselines.delete(key);
	baselines.set(key, {
		content,
		at: Date.now()
	});
	while (baselines.size > BASELINE_LIMIT) {
		const oldest = baselines.keys().next();
		if (oldest.done === true) break;
		baselines.delete(oldest.value);
	}
}
/** 当前基线；没有时返回 undefined。 */
function baselineOf(cwd, path) {
	return baselines.get(baselineKey(cwd, path))?.content;
}
/** 读磁盘上的改动内容；文件不存在（被删）返回 null。 */
async function readOptional(cwd, path) {
	let absolute;
	try {
		({absolute} = await workspacePath(cwd, path));
	} catch {
		return null;
	}
	try {
		const info = await stat(absolute);
		if (!info.isFile() || info.size > FILE_MAX_CHARS * 4) return null;
		return await readFile(absolute, "utf8");
	} catch {
		return null;
	}
}
/** 文件是否真的在磁盘上（区分「被删除」与「太大/读不了」）。 */
async function fileExists(cwd, path) {
	try {
		const { absolute } = await workspacePath(cwd, path);
		return (await stat(absolute)).isFile();
	} catch {
		return false;
	}
}
/** `git show HEAD:<path>`：受版本控制文件的「上次提交」内容；不跟踪/无 HEAD 时返回 undefined。 */
async function gitHeadContent(cwd, path) {
	try {
		const result = await run("git", ["show", `HEAD:${path}`], cwd, 1e4);
		return result.code === 0 ? result.stdout : void 0;
	} catch {
		return;
	}
}
/** 当前工作区改动清单（只算 git 状态，不读文件内容）。
*
* `git status` 是一次进程调用（Windows 上约 100–200ms）；文件变化事件成串到达时，
* 400ms 合并窗口叠加面板刷新仍可能连续触发多次。这里按工作区缓存 1.5 秒，
* 还原/回滚这类真的改变了状态的操作会主动清掉缓存。
*/
const STATUS_TTL_MS = 1500;
const statusCache = /* @__PURE__ */ new Map();
function changedFiles(cwd) {
	const key = normalize(cwd);
	const cached = statusCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at <= STATUS_TTL_MS) return cached.value;
	const value = loadChangedFiles(cwd);
	value.catch(() => {
		if (statusCache.get(key)?.value === value) statusCache.delete(key);
	});
	statusCache.set(key, {
		at: Date.now(),
		value
	});
	return value;
}
/** 文件状态真的变了之后清缓存（还原/回滚/切换工作区）。 */
function invalidateReviewStatus(cwd) {
	if (cwd === void 0) statusCache.clear();
	else statusCache.delete(normalize(cwd));
}
async function loadChangedFiles(cwd) {
	try {
		return (await gitStatus(cwd)).changes.map((change) => ({
			path: change.path,
			status: change.untracked ? "??" : change.worktree !== " " ? change.worktree : change.index,
			untracked: change.untracked
		}));
	} catch {
		return [];
	}
}
/**
* 列出改动并标出「已确认」。
*
* 这里**不**为每个文件去读 `git show HEAD`：那是一次进程调用，几十个改动文件就会把面板刷新
* 拖到几秒。清单只需要回答「有没有看过」，内存基线足够；HEAD 内容在打开差异与点还原时再取。
*/
async function reviewList(cwd) {
	const files = await changedFiles(cwd);
	const rows = [];
	let budget = REVIEW_READ_BUDGET;
	for (const file of files) {
		const confirmedDelete = confirmedDeletes.has(baselineKey(cwd, file.path));
		const baseline = baselineOf(cwd, file.path);
		let reviewed = false;
		if (baseline !== void 0 && baseline.length <= budget) {
			const current = await readOptional(cwd, file.path);
			if (current !== null) {
				budget -= Math.min(baseline.length, current.length);
				reviewed = current === baseline;
			} else if (file.status === "D" && confirmedDelete) reviewed = true;
		}
		rows.push({
			path: file.path,
			status: file.status,
			untracked: file.untracked,
			tracked: !file.untracked,
			baseline: baseline === void 0 ? "none" : "baseline",
			reviewed
		});
	}
	rows.sort((left, right) => Number(left.reviewed) - Number(right.reviewed) || left.path.localeCompare(right.path));
	return {
		files: rows,
		checkpoints: (await readCheckpoints(cwd)).map(summaryOf)
	};
}
async function reviewDiff(cwd, path) {
	let before = baselineOf(cwd, path);
	let source = before === void 0 ? "none" : "baseline";
	if (before === void 0) {
		before = await gitHeadContent(cwd, path);
		if (before !== void 0) {
			rememberBaseline(cwd, path, before);
			source = "git";
		}
	}
	const after = await readOptional(cwd, path);
	const binary = (before ?? "").includes("\0") || (after ?? "").includes("\0");
	const tooLarge = (before?.length ?? 0) > FILE_MAX_CHARS || (after?.length ?? 0) > FILE_MAX_CHARS;
	return {
		path,
		before: tooLarge ? "" : before ?? "",
		after: tooLarge ? "" : after ?? "",
		source,
		binary,
		tooLarge,
		deleted: after === null && !await fileExists(cwd, path)
	};
}
/** 确认一次改动：把当前内容记为新的基线；文件已删除时记一笔「已确认删除」。 */
async function acceptReview(cwd, path) {
	const current = await readOptional(cwd, path);
	if (current === null) {
		confirmedDeletes.add(baselineKey(cwd, path));
		return { reviewed: true };
	}
	confirmedDeletes.delete(baselineKey(cwd, path));
	rememberBaseline(cwd, path, current);
	return { reviewed: true };
}
/** 确认列表里的全部改动（客户端批量操作）。 */
async function acceptAllReview(cwd, paths) {
	let reviewed = 0;
	for (const path of paths) {
		const current = await readOptional(cwd, path);
		if (current === null) {
			confirmedDeletes.add(baselineKey(cwd, path));
			reviewed++;
			continue;
		}
		confirmedDeletes.delete(baselineKey(cwd, path));
		rememberBaseline(cwd, path, current);
		reviewed++;
	}
	return { reviewed };
}
/**
* 把文件还原到基线（或从基线删除）。
*
* 删除的文件（基线存在、磁盘没有）会被重新写出来；没有基线的文件拒绝还原 —— 没有「原样」可用。
* 还原成功之后基线被同步成写回去的内容，列表里这条会变成已确认。
*/
async function restoreReview(cwd, path) {
	let before = baselineOf(cwd, path);
	if (before === void 0) before = await gitHeadContent(cwd, path);
	if (before === void 0) return {
		restored: false,
		reason: "没有可用的基线（文件可能尚未提交），无法还原"
	};
	const after = await readOptional(cwd, path);
	if (after === before) return {
		restored: false,
		reason: "文件与基线一致，无需还原"
	};
	await createCheckpoint(cwd, `还原前自动备份：${path}`, [path]).catch(() => void 0);
	if (after !== null) rememberBaseline(cwd, path, after);
	await restoreDocument(cwd, path, before);
	invalidateReviewStatus(cwd);
	confirmedDeletes.delete(baselineKey(cwd, path));
	rememberBaseline(cwd, path, before);
	return { restored: true };
}
/** 检查点文件路径；顺带保证目录存在并自带忽略规则。 */
async function checkpointPath(cwd) {
	const directory = join(cwd, CHECKPOINT_DIR);
	await mkdir(directory, { recursive: true }).catch(() => void 0);
	await writeFile(join(directory, ".gitignore"), "*\n", "utf8").catch(() => void 0);
	return join(directory, CHECKPOINT_FILE);
}
async function readCheckpoints(cwd) {
	try {
		const raw = await readFile(await checkpointPath(cwd), "utf8");
		const value = JSON.parse(raw);
		if (value === null || typeof value !== "object" || !Array.isArray(value.checkpoints)) return [];
		return value.checkpoints.filter(isStoredCheckpoint);
	} catch {
		return [];
	}
}
function isStoredCheckpoint(value) {
	if (value === null || typeof value !== "object") return false;
	const row = value;
	return typeof row["id"] === "string" && typeof row["at"] === "number" && typeof row["label"] === "string" && Array.isArray(row["entries"]);
}
async function writeCheckpoints(cwd, list) {
	const kept = list.slice(0, CHECKPOINT_LIMIT);
	let total = kept.reduce((sum, checkpoint) => sum + checkpointChars(checkpoint), 0);
	while (kept.length > 1 && total > CHECKPOINTS_STORE_CHARS) {
		const removed = kept.pop();
		if (removed === void 0) break;
		total -= checkpointChars(removed);
	}
	const target = await checkpointPath(cwd);
	const temp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temp, JSON.stringify({
		version: 1,
		checkpoints: kept
	}), "utf8");
	await rename(temp, target);
}
function summaryOf(checkpoint) {
	return {
		id: checkpoint.id,
		at: checkpoint.at,
		label: checkpoint.label,
		files: checkpoint.entries.length,
		skipped: checkpoint.skipped
	};
}
/**
* 建立检查点：把当前所有改动文件的内容存一份。
*
* 超过单文件或总量上限时整次拒绝而不是悄悄少存：一个不完整的检查点会在回滚时造成
* 「一半文件退回去、一半没退」，比没有检查点更危险。
*/
async function createCheckpoint(cwd, label, extraPaths = []) {
	const files = await changedFiles(cwd);
	const paths = [.../* @__PURE__ */ new Set([...files.map((file) => file.path), ...extraPaths])];
	const entries = [];
	let total = 0;
	for (const path of paths) {
		const content = await readOptional(cwd, path);
		if (content !== null && content.length > FILE_MAX_CHARS) throw new Error(`文件 ${path} 超过 1MB，无法建立完整检查点`);
		const size = content?.length ?? 0;
		if (total + size > CHECKPOINT_TOTAL_CHARS) throw new Error("工作区改动过大，无法建立检查点（超过 8MB）");
		total += size;
		entries.push({
			path,
			content
		});
	}
	const checkpoint = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		at: Date.now(),
		label,
		files: entries.length,
		skipped: 0,
		entries
	};
	await writeCheckpoints(cwd, [checkpoint, ...await readCheckpoints(cwd)]);
	return summaryOf(checkpoint);
}
/** 回滚到某个检查点；回滚前自动把当前状态存为「回滚前」检查点，所以回滚本身可撤销。 */
async function rollbackCheckpoint(cwd, id) {
	const target = (await readCheckpoints(cwd)).find((checkpoint) => checkpoint.id === id);
	if (target === void 0) throw new Error("检查点不存在或已被清理");
	const safety = await createCheckpoint(cwd, "回滚前自动备份", target.entries.map((entry) => entry.path));
	let restored = 0;
	let skipped = 0;
	for (const entry of target.entries) try {
		await restoreDocument(cwd, entry.path, entry.content);
		if (entry.content !== null) rememberBaseline(cwd, entry.path, entry.content);
		restored++;
	} catch {
		skipped++;
	}
	invalidateReviewStatus(cwd);
	return {
		restored,
		skipped,
		checkpoint: safety,
		paths: target.entries.map((entry) => entry.path)
	};
}
/** 删除一个检查点。 */
async function deleteCheckpoint(cwd, id) {
	const list = await readCheckpoints(cwd);
	const next = list.filter((checkpoint) => checkpoint.id !== id);
	if (next.length === list.length) return { deleted: false };
	await writeCheckpoints(cwd, next);
	return { deleted: true };
}
/** 供 api.ts 在 fs.read/fs.save 之后记录基线；只记录文本内容。 */
function rememberDocumentBaseline(cwd, document) {
	if (document.binary || document.tooLarge) return;
	rememberBaseline(cwd, document.path, document.content);
}
//#endregion
//#region src/api.ts
/**
* 把客户端发来的方法名分发到具体的宿主操作。
* 从 index.ts 拆出：这里只做「方法名 → 实现」的映射与参数取值，与路由注册无关。
*/
async function dispatch(ctx, method, body, signal) {
	const sessionId = stringField$1(body, "sessionId");
	const cwd = cwdFor(ctx, sessionId);
	if (method.startsWith("language.")) return dispatchLanguage(ctx, method, body, cwd, signal);
	switch (method) {
		case "workspace": return {
			cwd,
			name: cwd.split(/[\\/]/).at(-1) || cwd
		};
		case "completion.index.status": return completionIndexFor(cwd).then((index) => index.status());
		case "completion.index.refresh": return completionIndexFor(cwd).then((index) => index.refresh());
		case "completion.config": {
			const resolved = resolveProvider(ctx);
			const experiment = groupForSession(sessionId);
			const settings = completionSettings();
			return {
				source: resolved.source,
				model: resolved.model,
				profile: resolved.profile.id,
				experiment,
				params: paramsForGroup(experiment),
				security: { rules: DEFAULT_SECURITY_RULES },
				endpoint: "/dsh-vscode/completion",
				settings: {
					route: settings.route === void 0 ? null : `${settings.route.provider}/${settings.route.model}`,
					fallback: settings.fallback
				}
			};
		}
		case "completion.telemetry": {
			const kind = stringField$1(body, "kind");
			if (kind !== "shown" && kind !== "accepted" && kind !== "cancelled" && kind !== "failed") throw new WorkbenchError("invalid-argument", `unknown telemetry kind ${kind}`);
			completionTelemetry.record({
				kind,
				sessionId,
				language: stringField$1(body, "language"),
				...typeof body.model === "string" && body.model !== "" ? { model: body.model } : {},
				...typeof body.experiment === "string" && body.experiment !== "" ? { experiment: body.experiment } : {},
				...typeof body.firstByteMs === "number" && Number.isFinite(body.firstByteMs) ? { firstByteMs: body.firstByteMs } : {},
				...typeof body.candidateCount === "number" && Number.isFinite(body.candidateCount) ? { candidateCount: body.candidateCount } : {},
				...typeof body.error === "string" && body.error !== "" ? { error: body.error } : {}
			});
			return { recorded: true };
		}
		case "completion.stats": return {
			overall: completionTelemetry.stats(),
			byExperiment: completionTelemetry.byExperiment(),
			lastFailure: completionTelemetry.failure()
		};
		case "fs.list": return listFiles(cwd, stringField$1(body, "path"));
		case "fs.files": return listWorkspaceFiles(cwd);
		case "fs.read": {
			const document = await readDocument(cwd, stringField$1(body, "path"), body.force === true);
			rememberDocumentBaseline(cwd, document);
			return document;
		}
		case "fs.save": {
			const document = await saveDocument(cwd, stringField$1(body, "path"), stringField$1(body, "content"), stringField$1(body, "revision"));
			rememberDocumentBaseline(cwd, document);
			return document;
		}
		case "fs.create": return createEntry(cwd, stringField$1(body, "path"), body.kind === "directory" ? "directory" : "file").then(() => ({ ok: true }));
		case "fs.rename": return renameEntry(cwd, stringField$1(body, "path"), stringField$1(body, "nextPath")).then(() => ({ ok: true }));
		case "fs.delete": return deleteEntry(cwd, stringField$1(body, "path")).then(() => ({ ok: true }));
		case "fs.copy": return copyEntry(cwd, stringField$1(body, "path"), stringField$1(body, "directory"));
		case "fs.move": return moveEntry(cwd, stringField$1(body, "path"), stringField$1(body, "directory"));
		case "search": return searchWorkspace(cwd, body, signal);
		case "search.replace": return replaceInWorkspace(cwd, {
			...body,
			replace: stringField$1(body, "replace")
		}, signal);
		case "git.status": return gitStatus(cwd);
		case "git.action": return gitAction(cwd, stringField$1(body, "action"), typeof body.path === "string" ? body.path : void 0, typeof body.value === "string" ? body.value : void 0);
		case "ai.inlineEdit": return runInlineEdit(ctx, sessionId ?? "", readInlineEditInput(body), signal);
		case "review.list": return reviewList(cwd);
		case "review.diff": return reviewDiff(cwd, stringField$1(body, "path"));
		case "review.accept": return acceptReview(cwd, stringField$1(body, "path"));
		case "review.acceptAll": return acceptAllReview(cwd, Array.isArray(body.paths) ? body.paths.filter((path) => typeof path === "string") : []);
		case "review.restore": return restoreReview(cwd, stringField$1(body, "path"));
		case "review.checkpoint": return createCheckpoint(cwd, typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : "手动检查点");
		case "review.rollback": return rollbackCheckpoint(cwd, stringField$1(body, "id"));
		case "review.checkpoint.delete": return deleteCheckpoint(cwd, stringField$1(body, "id"));
		default: throw new WorkbenchError("not-found", `unknown workbench API method ${method}`, 404);
	}
}
//#endregion
//#region src/modelRoutes.ts
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_LIMIT = 200;
const ROUTE_LABEL = "dsh-aide: model routes";
/**
* 收集 DSH 可用的 provider/model 路由；永不抛错，失败的那一路记为缺失。
*
* 顺序即 provider 的注册顺序 + 适配器公布模型时的顺序：设置页照这个顺序展示，用户看到的
* 「第一项」与 DSH 自己的偏好顺序一致。
*/
async function collectDshModelRoutes(ctx, options = {}) {
	const timeoutMs = normalizedTimeout(options.timeoutMs);
	const limit = normalizedLimit(options.limit);
	try {
		const defaultRoute = defaultRouteOf(ctx);
		const llm = safeGet(ctx, "llm");
		if (llm === null || llm === void 0 || typeof llm.listProviders !== "function") return {
			default: defaultRoute,
			routes: []
		};
		const providers = await readProviders(llm);
		return {
			default: defaultRoute,
			routes: mergeRoutes(providers, await Promise.all(providers.map((provider) => readModels(llm, provider, timeoutMs))), limit)
		};
	} catch {
		return {
			default: null,
			routes: []
		};
	}
}
/**
* 注册 `GET /dsh-vscode/model-routes`（会话无关，只需连接认证）。
*
* 不并进 `/dsh-vscode/api` 的原因与设置页端点相同：`/api` 先解析会话工作目录，还没选会话时一律 409，
* 而模型下拉在这之前就要能用。
*/
function registerModelRoutes(ctx, helpers) {
	const mount = () => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-vscode/model-routes",
		handler: async (req, res) => {
			if (!helpers.authorize(req, res)) return;
			if (req.method !== "GET") return helpers.send(res, 405, {
				ok: false,
				error: {
					code: "method",
					message: "GET required"
				}
			});
			try {
				helpers.send(res, 200, {
					ok: true,
					value: await collectDshModelRoutes(ctx)
				});
			} catch (error) {
				helpers.sendError(res, error);
			}
		}
	});
	if (helpers.effect !== void 0) helpers.effect(mount, ROUTE_LABEL);
	else ctx.effect(mount, ROUTE_LABEL);
}
/** 读当前默认模型；服务缺失或选择不可用时为 null（列表本身仍然可用）。 */
function defaultRouteOf(ctx) {
	try {
		const service = safeGet(ctx, "agentDefaultModel");
		if (service === null || service === void 0 || typeof service.currentSelection !== "function") return null;
		const selection = service.currentSelection();
		if (!isRecord(selection)) return null;
		const provider = stringField(selection, "provider");
		const model = stringField(selection, "model");
		return provider === void 0 || model === void 0 ? null : `${provider}/${model}`;
	} catch {
		return null;
	}
}
/** provider 列表：按注册顺序取 id，去重后保留原始顺序。 */
async function readProviders(llm) {
	try {
		const listed = await Promise.resolve(llm.listProviders());
		if (!Array.isArray(listed)) return [];
		const providers = [];
		const seen = /* @__PURE__ */ new Set();
		for (const entry of listed) {
			const id = providerIdOf(entry);
			if (id === void 0 || seen.has(id)) continue;
			seen.add(id);
			providers.push(id);
		}
		return providers;
	} catch {
		return [];
	}
}
/**
* 读一个 provider 的模型目录。
*
* 不支持发现（没有 listModels、或直接抛错）、超时，都按「这一路没有目录」处理：别的 provider 不受影响。
*/
async function readModels(llm, provider, timeoutMs) {
	if (typeof llm.listModels !== "function") return [];
	try {
		const listed = await withTimeout(() => llm.listModels(provider), timeoutMs);
		return Array.isArray(listed) ? listed : [];
	} catch {
		return [];
	}
}
/** 合并成 `provider/model` 路由：按 provider 顺序、模型顺序，去重并截断到上限。 */
function mergeRoutes(providers, catalogs, limit) {
	const routes = [];
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < providers.length && routes.length < limit; index++) {
		const provider = providers[index];
		if (provider === void 0) continue;
		for (const listed of catalogs[index] ?? []) {
			const entry = modelEntryOf(listed);
			if (entry === void 0) continue;
			const route = `${provider}/${entry.id}`;
			if (seen.has(route)) continue;
			seen.add(route);
			routes.push({
				route,
				provider,
				model: entry.id,
				label: entry.label
			});
			if (routes.length >= limit) break;
		}
	}
	return routes;
}
/**
* 给一次模型发现加超时。
*
* 不用 AbortSignal：`listModels` 的契约里没有 signal 参数，传不进去；这里按「结果与超时赛跑」
* 实现，谁先到算谁。迟到的那一方（例如超时后才返回或抛错的适配器）直接丢弃，不会变成
* unhandled rejection，也不会改变已经返回的列表。
*/
function withTimeout(run, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		Promise.resolve().then(run).then((value) => finish(value), () => finish(void 0));
		const timer = setTimeout(() => finish(void 0), timeoutMs);
	});
}
/** provider 条目可能是 `{ id }`，也可能是裸 id；两种都认。 */
function providerIdOf(entry) {
	if (typeof entry === "string") return stringValue(entry);
	if (!isRecord(entry)) return void 0;
	return stringField(entry, "id");
}
/** 模型条目可能是 `{ id, displayName? }`，也可能只是裸模型名。 */
function modelEntryOf(entry) {
	if (typeof entry === "string") {
		const id = stringValue(entry);
		return id === void 0 ? void 0 : {
			id,
			label: id
		};
	}
	if (!isRecord(entry)) return void 0;
	const id = stringField(entry, "id") ?? stringField(entry, "model");
	if (id === void 0) return void 0;
	return {
		id,
		label: (stringField(entry, "displayName") ?? stringField(entry, "name") ?? id).trim()
	};
}
/** 服务缺失时 ctx.get 可能抛错（组合未加载），这里统一按要求「没有这个服务」处理。 */
function safeGet(ctx, name) {
	try {
		return ctx.get(name);
	} catch {
		return;
	}
}
function normalizedTimeout(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}
function normalizedLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.max(0, Math.floor(value));
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/** 非空字符串才认：空白 id / 标签按缺失处理，避免生成 `provider/` 这种路由。 */
function stringValue(value) {
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function stringField(record, key) {
	return stringValue(record[key]);
}
//#endregion
//#region src/routes.ts
/**
* 宿主侧的全部 HTTP / WebSocket 路由。
*
* 从 index.ts 拆出：那里只留 name / inject / apply 三件事，路由与文件监听放在这里。
* 静态资源一律走 immutable 缓存；入参来自 URL 的部分都经 authorize() 与包目录包含判断守卫。
*/
/**
* 按工作区共享的文件监听。
*
* 原先每条 ws/files 连接都自己建一次监听。实测这个工作区（仓库根）约 1.8 万个非
* node_modules 文件，遍历式建监听要 3.4 秒，而工作台每次打开、每次重连都要付一遍；
* 这段时间里宿主是共用的，终端的响应也会被一起拖住（实测宿主 API 往返延迟从 2ms 冲到 146ms）。
*
* 现在同一工作区共用一个监听，最后一个使用者离开后再等一小段时间才关，避免「关掉又马上打开」
* 时白重建一次。
*/
var WorkspaceWatch = class {
	create;
	graceMs;
	entries = /* @__PURE__ */ new Map();
	constructor(create, graceMs = 5e3) {
		this.create = create;
		this.graceMs = graceMs;
	}
	acquire(workspace) {
		const existing = this.entries.get(workspace);
		if (existing !== void 0) {
			clearTimeout(existing.closing);
			existing.closing = void 0;
			existing.users++;
			return existing.watcher;
		}
		const watcher = this.create(workspace);
		this.entries.set(workspace, {
			watcher,
			users: 1,
			closing: void 0
		});
		return watcher;
	}
	release(workspace) {
		const entry = this.entries.get(workspace);
		if (entry === void 0) return;
		entry.users--;
		if (entry.users > 0) return;
		entry.closing = setTimeout(() => {
			entry.closing = void 0;
			if (entry.users > 0) return;
			this.entries.delete(workspace);
			entry.watcher.close();
		}, this.graceMs);
	}
	closeAll() {
		for (const [workspace, entry] of [...this.entries]) {
			clearTimeout(entry.closing);
			this.entries.delete(workspace);
			entry.watcher.close();
		}
	}
	/** 仅供测试观察当前持有几个监听。 */
	size() {
		return this.entries.size;
	}
};
/**
* 设置页要显示的全部状态。
*
* 除设置本身，还带上「当前实际在用哪个模型」和「最近一次补全失败原因」：排查「没有补全」时
* 这两条决定下一步该看哪里 —— 是路由配错了，还是模型调用本身失败。来源解析与补全请求走同一套
* resolveProvider，所以这里显示的就是请求真正会用的那条路。
*/
function settingsPayload(ctx) {
	const resolved = resolveProvider(ctx);
	return {
		completion: {
			...completionSettingsView(),
			effective: {
				source: resolved.source,
				model: resolved.model
			},
			lastFailure: completionTelemetry.failure() ?? null
		},
		language: languageHostFor(ctx).settingsView()
	};
}
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
/**
* 注册一条静态资源路由。
*
* 七个资源 handler 原先各写一遍 authorize → 解析路径 → 取 asset → writeHead → readFile → sendError，
* 差异只有三处：exact/prefix、是否 decodeURIComponent、文件还是 JSON。这里用参数表达差异；
* URL、响应头（含字段顺序）、缓存策略与错误路径全部保持不变。
*/
function registerImmutableAssetRoute(ctx, route) {
	ctx.effect(() => ctx.webServer.register({
		kind: route.kind,
		path: route.path,
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			try {
				const resource = route.resource === void 0 ? "" : route.resource(new URL(req.url ?? "/", "http://dsh.local").pathname);
				const asset = await route.resolve(resource);
				if ("json" in asset) {
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": IMMUTABLE_CACHE_CONTROL
					});
					res.end(asset.json);
				} else {
					res.writeHead(200, {
						"content-type": asset.type,
						"cache-control": IMMUTABLE_CACHE_CONTROL
					});
					res.end(await readFile(asset.path));
				}
			} catch (error) {
				sendError(res, error);
			}
		}
	}), route.label);
}
/**
* 工作区文件事件的 150ms 聚合。
*
* 普通事件：换算成工作区相对路径（统一 `/`）后同批去重，发送 `{type:'files.changed', paths}`。
* watcher 溢出（`RESCAN_EVENT`）：置 reload，flush 时发送 `{type:'files.changed', paths, reload:true}`
* —— 客户端据此整体重扫，而不是只刷新受影响的目录。没有事件时不会发消息，与拆分前一致。
*/
function createFilesChangedBatcher(workspace, send, delayMs = 150) {
	let paths = /* @__PURE__ */ new Set();
	let reload = false;
	let timer;
	const flush = () => {
		timer = void 0;
		const message = {
			type: "files.changed",
			paths: [...paths],
			...reload ? { reload: true } : {}
		};
		paths = /* @__PURE__ */ new Set();
		reload = false;
		send(message);
	};
	const schedule = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(flush, delayMs);
	};
	return {
		push(event, changed) {
			if (event === "rescan") reload = true;
			else {
				const normalized = isAbsolute(changed) ? relative(workspace, changed) : changed;
				paths.add(normalized.split(sep).join("/"));
			}
			schedule();
		},
		dispose() {
			if (timer !== void 0) clearTimeout(timer);
			timer = void 0;
		}
	};
}
function registerWorkbenchRoutes(ctx) {
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: Codicon font",
		kind: "exact",
		path: "/dsh-vscode/codicons/codicon.ttf",
		resolve: () => codiconAsset()
	});
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: PDF.js worker",
		kind: "exact",
		path: "/dsh-vscode/pdfjs/worker.mjs",
		resolve: () => pdfWorkerAsset()
	});
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: TextMate grammars",
		kind: "prefix",
		path: "/dsh-vscode/grammar",
		resource: (pathname) => pathname.slice(20),
		resolve: async (name) => ({ json: JSON.stringify(await readGrammar(name)) })
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-vscode/api",
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			if (req.method !== "POST") return send(res, 405, {
				ok: false,
				error: {
					code: "method",
					message: "POST required"
				}
			});
			try {
				const controller = new AbortController();
				req.once("aborted", () => controller.abort());
				send(res, 200, {
					ok: true,
					value: await dispatch(ctx, new URL(req.url ?? "/", "http://dsh.local").pathname.slice(16), await readBody(req), controller.signal),
					wsBase: localBase(req)
				});
			} catch (error) {
				sendError(res, error);
			}
		}
	}), "dsh-aide: API");
	registerCompletionRoute(ctx, {
		authorize: (req, res) => authorize(req, res, ctx.connection),
		readBody,
		send,
		sendError,
		cwdFor: (sessionId) => cwdFor(ctx, sessionId)
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-vscode/settings",
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			try {
				if (req.method === "GET") return send(res, 200, {
					ok: true,
					value: settingsPayload(ctx)
				});
				if (req.method !== "POST") return send(res, 405, {
					ok: false,
					error: {
						code: "method",
						message: "GET or POST required"
					}
				});
				const body = await readBody(req);
				const patch = {};
				if ("route" in body) {
					if (body["route"] !== null && typeof body["route"] !== "string") throw new WorkbenchError("invalid-argument", "route must be a string or null");
					patch.route = body["route"];
				}
				if ("fallback" in body) {
					if (typeof body["fallback"] !== "boolean") throw new WorkbenchError("invalid-argument", "fallback must be a boolean");
					patch.fallback = body["fallback"];
				}
				let languagePatch;
				if ("language" in body) {
					const raw = body["language"];
					if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new WorkbenchError("invalid-argument", "language must be an object");
					const language = raw;
					languagePatch = {};
					if ("enabled" in language) {
						if (typeof language["enabled"] !== "boolean") throw new WorkbenchError("invalid-argument", "language.enabled must be a boolean");
						languagePatch.enabled = language["enabled"];
					}
					if ("builtinTypescript" in language) {
						if (typeof language["builtinTypescript"] !== "boolean") throw new WorkbenchError("invalid-argument", "language.builtinTypescript must be a boolean");
						languagePatch.builtinTypescript = language["builtinTypescript"];
					}
				}
				updateCompletionSettings(patch);
				if (languagePatch !== void 0) {
					const host = languageHostFor(ctx);
					try {
						updateLanguageSettings(languagePatch, void 0, void 0, host.servers());
					} catch (error) {
						if (error instanceof LanguageSettingsWriteError) throw new WorkbenchError("language-settings-write", error.message);
						throw error;
					}
					host.reset();
				}
				send(res, 200, {
					ok: true,
					value: settingsPayload(ctx)
				});
			} catch (error) {
				if (error instanceof SettingsWriteError) send(res, 400, {
					ok: false,
					error: {
						code: "settings-write",
						message: error.message
					}
				});
				else sendError(res, error);
			}
		}
	}), "dsh-aide: settings");
	registerModelRoutes(ctx, {
		authorize: (req, res) => authorize(req, res, ctx.connection),
		send,
		sendError
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-vscode/upload",
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			if (req.method !== "POST") return send(res, 405, {
				ok: false,
				error: {
					code: "method",
					message: "POST required"
				}
			});
			try {
				const url = new URL(req.url ?? "/", "http://dsh.local");
				const sessionId = url.searchParams.get("sessionId");
				const directory = url.searchParams.get("directory");
				const name = url.searchParams.get("name");
				if (sessionId === null || directory === null || name === null) throw new WorkbenchError("bad-request", "sessionId, directory and name are required");
				send(res, 201, {
					ok: true,
					value: await uploadFile(cwdFor(ctx, sessionId), directory, name, await readBinaryBody(req))
				});
			} catch (error) {
				sendError(res, error);
			}
		}
	}), "dsh-aide: file upload");
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-vscode/file",
		handler: async (req, res) => {
			if (!authorize(req, res, ctx.connection)) return;
			try {
				const url = new URL(req.url ?? "/", "http://dsh.local");
				const sessionId = url.searchParams.get("sessionId");
				const path = url.searchParams.get("path");
				if (sessionId === null || path === null) throw new WorkbenchError("bad-request", "sessionId and path are required");
				const asset = await workspacePreviewFile(cwdFor(ctx, sessionId), path);
				res.writeHead(200, {
					"content-type": asset.type,
					"x-content-type-options": "nosniff",
					"cache-control": "no-store"
				});
				res.end(await readFile(asset.path));
			} catch (error) {
				sendError(res, error);
			}
		}
	}), "dsh-aide: file preview");
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: Monaco assets",
		kind: "prefix",
		path: "/dsh-vscode/monaco",
		resource: (pathname) => decodeURIComponent(pathname.slice(19)),
		resolve: monacoAsset
	});
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: KaTeX assets",
		kind: "prefix",
		path: "/dsh-vscode/katex",
		resource: (pathname) => decodeURIComponent(pathname.slice(18)),
		resolve: katexAsset
	});
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: file type icons",
		kind: "prefix",
		path: "/dsh-vscode/file-icons",
		resource: (pathname) => decodeURIComponent(pathname.slice(23)),
		resolve: fileIconAsset
	});
	registerImmutableAssetRoute(ctx, {
		label: "dsh-aide: oniguruma wasm",
		kind: "prefix",
		path: "/dsh-vscode/onig",
		resolve: () => onigWasmAsset()
	});
	const wss = new WebSocketServer({ noServer: true });
	const watches = new WorkspaceWatch(createWorkspaceWatcher);
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/dsh-vscode/ws/files",
		handler(req, socket, head) {
			if (ctx.connection.requestRejection(req) !== void 0) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				const sessionId = new URL(req.url ?? "/", "http://dsh.local").searchParams.get("sessionId");
				if (sessionId === null) {
					ws.close(1008, "sessionId required");
					return;
				}
				let workspace;
				try {
					workspace = cwdFor(ctx, sessionId);
				} catch {
					ws.close(1008, "session workspace unavailable");
					return;
				}
				const watcher = watches.acquire(workspace);
				const batcher = createFilesChangedBatcher(workspace, (message) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
				});
				const onAll = (event, changed) => {
					batcher.push(event, changed);
				};
				watcher.on("all", onAll);
				ws.on("close", () => {
					batcher.dispose();
					watcher.off("all", onAll);
					watches.release(workspace);
				});
			});
		}
	}), "dsh-aide: file watcher");
	/**
	* 语言服务的推送通道。
	*
	* 请求仍走 HTTP（一跳一答、天然可重试）；诊断、服务器状态这类「宿主主动说」的消息走这条
	* WebSocket 推到同一个工作区的客户端。客户端隐藏工作台时会断开，回来重连后立刻收到一次状态。
	*/
	const languageHost = languageHostFor(ctx);
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/dsh-vscode/ws/language",
		handler(req, socket, head) {
			if (ctx.connection.requestRejection(req) !== void 0) {
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => {
				const sessionId = new URL(req.url ?? "/", "http://dsh.local").searchParams.get("sessionId");
				if (sessionId === null) {
					ws.close(1008, "sessionId required");
					return;
				}
				let workspace;
				try {
					workspace = cwdFor(ctx, sessionId);
				} catch {
					ws.close(1008, "session workspace unavailable");
					return;
				}
				languageHost.attach(workspace, ws);
				ws.on("close", () => languageHost.detach(workspace, ws));
			});
		}
	}), "dsh-aide: language websocket");
	ctx.effect(() => () => {
		languageHost.dispose();
	}, "dsh-aide: language teardown");
	ctx.effect(() => () => {
		watches.closeAll();
		wss.close();
	}, "dsh-aide: watcher teardown");
}
//#endregion
//#region src/index.ts
/** 从 cordis 的 entry 选项里取本插件的配置；形状不认识就返回 undefined。 */
function entryConfig(ctx) {
	return (ctx.fiber?.entry?.options)?.config;
}
const name = "dsh-aide";
const inject = [
	"webServer",
	"sessions",
	"connection",
	"workingDirectory"
];
/**
* 插件入口。
*
* 只做两件事：装终端、注册路由。方法分发在 api.ts，路由与文件监听在 routes.ts ——
* 原先三者都挤在本文件里（177 行），拆开后入口只剩接线，改路由不必再翻一整个文件。
*
* 第二个参数是插件配置（profile 里那一行的 config，或应用里的插件设置）：补全用哪条模型路由、
* 模型失败要不要回落本地兜底，都从这里读；环境变量可以覆盖它，便于排查与临时试验。
*/
function apply(ctx, config) {
	setCompletionSettings(config ?? entryConfig(ctx));
	setLanguageSettings(config ?? entryConfig(ctx));
	installTerminal(ctx);
	registerWorkbenchRoutes(ctx);
}
//#endregion
export { WorkbenchError, apply, inject, name };

//# sourceMappingURL=index.js.map