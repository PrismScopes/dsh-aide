import { parentPort, workerData } from "node:worker_threads";
import ts from "typescript";
import { resolve } from "node:path";
//#region src/language/scan.ts
const EMPTY_SCAN = {
	checked: 0,
	errors: 0,
	warnings: 0
};
/** 单文件诊断上限：生成代码/类型爆炸时避免一条文件把消息和面板撑爆。 */
const MAX_DIAGNOSTICS_PER_FILE = 500;
/** Windows / macOS 文件系统大小写不敏感；同时把 TS 的 `/` 路径与 Node 的 `\` 路径归一。 */
function keyOf(ts, path) {
	const normalized = resolve(path);
	return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}
/**
* 扫描整个程序。诊断一次性算完后按文件分组回调；单个文件回调之间让出事件循环，方便回退路径
* （非 worker）仍能响应取消，并让进度消息有机会被发出。
*/
async function scanProject(ts, options, onFile, signal, onTotal) {
	if (isAborted(signal)) return EMPTY_SCAN;
	const openDocuments = new Map(options.openDocuments.map((document) => [keyOf(ts, document.path), document]));
	const fileNames = [.../* @__PURE__ */ new Set([...options.rootFiles, ...options.openDocuments.map((document) => document.path)])];
	if (fileNames.length === 0) return EMPTY_SCAN;
	const host = {
		getSourceFile: (fileName, languageVersion) => {
			const text = openDocuments.get(keyOf(ts, fileName))?.content ?? ts.sys.readFile(fileName);
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
			...EMPTY_SCAN,
			error: "TypeScript 程序创建失败"
		};
	}
	if (isAborted(signal)) return EMPTY_SCAN;
	const sourceFiles = program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile);
	onTotal?.(sourceFiles.length);
	if (sourceFiles.length === 0) return EMPTY_SCAN;
	let raw;
	try {
		raw = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
	} catch {
		return {
			...EMPTY_SCAN,
			error: "TypeScript 诊断计算失败"
		};
	}
	if (isAborted(signal)) return EMPTY_SCAN;
	const byFile = /* @__PURE__ */ new Map();
	for (const diagnostic of raw) {
		const file = diagnostic.file;
		if (file === void 0 || diagnostic.start === void 0) continue;
		const key = keyOf(ts, file.fileName);
		const bucket = byFile.get(key);
		if (bucket === void 0) byFile.set(key, [diagnostic]);
		else bucket.push(diagnostic);
	}
	let checked = 0;
	let errors = 0;
	let warnings = 0;
	for (const [index, sourceFile] of sourceFiles.entries()) {
		if (isAborted(signal)) break;
		const path = sourceFile.fileName;
		const diagnostics = convertFileDiagnostics(ts, sourceFile, byFile.get(keyOf(ts, path)) ?? []);
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
		const tags = tagsOf(diagnostic);
		result.push({
			range: spanRange(ts, file, diagnostic.start, diagnostic.length ?? 0, text.length),
			severity: severityOf(diagnostic.category),
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
			code: `TS${diagnostic.code}`,
			source: "ts",
			...tags === void 0 ? {} : { tags },
			...related.length === 0 ? {} : { related }
		});
	}
	return result.sort((left, right) => comparePosition(left.range.start, right.range.start) || severityRank(left.severity) - severityRank(right.severity)).slice(0, MAX_DIAGNOSTICS_PER_FILE);
}
function relatedInformationOf(ts, diagnostic) {
	const related = [];
	for (const information of diagnostic.relatedInformation ?? []) {
		const file = information.file;
		if (file === void 0 || information.start === void 0) continue;
		related.push({
			path: file.fileName,
			range: spanRange(ts, file, information.start, information.length ?? 0, file.text.length),
			message: ts.flattenDiagnosticMessageText(information.messageText, " ")
		});
	}
	return related;
}
function spanRange(ts, file, start, length, textLength) {
	const safeStart = Math.max(0, Math.min(start, textLength));
	const safeEnd = Math.max(safeStart, Math.min(start + length, textLength));
	return {
		start: positionAt(ts, file, safeStart),
		end: positionAt(ts, file, safeEnd)
	};
}
function positionAt(ts, file, offset) {
	const position = ts.getLineAndCharacterOfPosition(file, offset);
	return {
		line: position.line,
		character: position.character
	};
}
function severityOf(category) {
	switch (category) {
		case 1: return "error";
		case 0: return "warning";
		default: return "info";
	}
}
function tagsOf(diagnostic) {
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
function comparePosition(left, right) {
	return left.line !== right.line ? left.line - right.line : left.character - right.character;
}
function isAborted(signal) {
	return signal?.aborted === true;
}
//#endregion
//#region src/language/scan-worker.ts
/**
* 工作区扫描 worker。
*
* 宿主把 rootFiles/编译设置/打开文档传进来，worker 自己加载一份 TypeScript、跑完程序级诊断，
* 再把结果逐文件发回。CPU 密集检查完全离开宿主事件循环，补全、Git、终端、HTTP 路由都不会被扫描
* 卡住。
*
* 只在生产构建里作为 `lib/scan-worker.js` 存在；源码测试环境走 provider 的进程内回退
* （同一个 `scanProject` 实现）。
*/
if (parentPort !== null) {
	const port = parentPort;
	const data = workerData;
	(async () => {
		try {
			let batch = [];
			const flush = () => {
				if (batch.length === 0) return;
				port.postMessage({
					type: "files",
					files: batch
				});
				batch = [];
			};
			const result = await scanProject(ts, data, (path, diagnostics) => {
				batch.push({
					path,
					diagnostics
				});
				if (batch.length >= 48) flush();
			}, void 0, (total) => {
				port.postMessage({
					type: "total",
					total
				});
			});
			flush();
			port.postMessage({
				type: "done",
				result
			});
		} catch (error) {
			port.postMessage({
				type: "error",
				message: error instanceof Error ? error.message : String(error)
			});
		}
	})();
}
//#endregion
export {};

//# sourceMappingURL=scan-worker.js.map