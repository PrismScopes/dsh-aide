<h1 align="center">DSH AIDE</h1>

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/dsh-aide-logo.svg" width="220" alt="DSH AIDE Logo">
</p>

<p align="center"><b>AIDE = AI + IDE</b>: a VS Code-style local development environment for DeepSeek Harness.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-aide"><img src="https://img.shields.io/npm/v/dsh-aide?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-aide"><img src="https://img.shields.io/npm/dm/dsh-aide?label=downloads" alt="npm downloads"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/stargazers"><img src="https://img.shields.io/github/stars/PrismScopes/dsh-aide?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/commits/main"><img src="https://img.shields.io/github/last-commit/PrismScopes/dsh-aide?label=last%20commit" alt="Last commit"></a>
  <a href="https://github.com/PrismScopes/dsh-aide/blob/main/LICENSE"><img src="https://img.shields.io/github/license/PrismScopes/dsh-aide?label=license" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://github.com/topics/dsh-plugin"><img alt="topic: dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-2ea44f?style=flat-square"></a>
  <a href="https://github.com/topics/deepseek-harness"><img alt="topic: deepseek-harness" src="https://img.shields.io/badge/topic-deepseek--harness-6f42c1?style=flat-square"></a>
  <a href="https://github.com/topics/dsh"><img alt="topic: dsh" src="https://img.shields.io/badge/topic-dsh-0969da?style=flat-square"></a>
  <a href="https://github.com/topics/ai"><img alt="topic: ai" src="https://img.shields.io/badge/topic-ai-8250df?style=flat-square"></a>
  <a href="https://github.com/topics/ide"><img alt="topic: ide" src="https://img.shields.io/badge/topic-ide-1f883d?style=flat-square"></a>
  <a href="https://github.com/topics/monaco-editor"><img alt="topic: monaco-editor" src="https://img.shields.io/badge/topic-monaco--editor-f9a825?style=flat-square"></a>
  <a href="https://github.com/topics/vscode-workbench"><img alt="topic: vscode-workbench" src="https://img.shields.io/badge/topic-vscode--workbench-007acc?style=flat-square"></a>
</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

## Highlights

- **One integrated AIDE**: explorer, Monaco editor, search, Git, terminal, and DSH conversation in one VS Code-style interface.
- **Complete file experience**: open text, Markdown, images, PDF, and Word files directly; the tree supports drag-and-drop uploads and common file operations.
- **Reliable and live**: atomic saves and revision checks prevent silent overwrites, while WebSocket updates flag external workspace changes.
- **Visual Git workflow**: status, staging, commits, branches, diffs, commit files, and a swimlane commit graph.
- **Persistent workspace context**: restore the tree, views, panels, and widths per workspace; terminals support multiple sessions, splits, and rename.
- **Built for DSH**: reuse the DSH conversation surface on the right and follow the DSH theme instead of shipping a second color scheme.

## Features

- **Files and editor**: lazy explorer with create, upload, drag-and-drop, rename, delete, and Git markers; Monaco tabs provide dirty state, atomic saves, and conflict notices.
- **Preview**: Markdown source, outline, relative links, and images; built-in PDF paging and zoom plus DOCX rendering, with DOC/ODT download support.
- **Search and replace**: `@vscode/ripgrep` supports case, whole-word, regex, and path filters. Results are grouped by file with every hit highlighted; replace one match, replace all, preserve case, step through hits with `F4` / `Shift+F4`, and the last search (including replacement text and options) survives reloads.
- **Git**: stage, unstage, discard, commit, branches, diffs, commit files, and the graph.
- **Terminal**: `node-pty` and xterm with up to eight sessions, rename, a right-side switcher, splits, ANSI output, and Ctrl+C. The host pre-warms the default shell when the panel opens, so a new terminal usually already has its prompt in the replay buffer; collapsing the panel or switching tabs keeps the xterm instances instead of rebuilding and replaying them.
- **Layout and DSH**: the primary view, terminal panel, and DSH conversation sidebar can be shown and resized independently; widths are dragged and double-clicked back to default in place, so they are not duplicated as settings.
- **Settings page**: the "AIDE" page under DSH settings is one scrolling page grouped into Editor / AI completion / Terminal / Shortcuts / About and diagnostics, using the same type scale as DSH settings (row title 14/20, hint 12/18, controls 14/32px). Editor: font size, line height, tab size and insert-spaces, word wrap (off/on/bounded), minimap, overview ruler, occurrence highlight, whitespace rendering, cursor style, smooth scrolling, sticky scroll, auto save and delay. AI completion: master switch, trigger delay, model route (**listed from the models DSH already has configured**, free-form allowed), failure fallback, plus the model actually in use and the last failure. Also terminal font size, the shortcut reference, and reset-to-defaults.
- **Occurrence highlight and overview ruler**: selecting or double-clicking a word highlights every occurrence in the document the way VS Code does, and a three-lane overview ruler appears on the right (selection, occurrences, and find matches are drawn in the scrollbar strip). Ruler markers use the foreground color (white on dark themes, no longer the blue accent), and the scrollbar slider is translucent so it never hides them.
- **Close confirmation and auto save**: closing a tab, bulk-closing (others/right/saved/all), or returning to DSH with unsaved edits opens a VS Code-style dialog (single: Save / Don't Save / Cancel; multiple: Save All / Don't Save All / Cancel with the file list). Files that fail to save stay open and report the error, and returning to DSH is blocked while any save failed. An optional delayed auto save is available too.
- **Localized context menus**: the explorer, tabs, code editor, terminal, and source control all have VS Code-style menus in Chinese — new/upload/cut/copy/paste/rename/delete, copy relative or absolute path, open in terminal, tab close-others/right/saved, editor undo-redo and find-replace, terminal copy/paste and clear, Git stage/unstage/discard/copy commit hash. Monaco's built-in English menu is disabled (`contextmenu:false`); menu contents are pure data (unit-tested) over one shared shell.
- **Richer editor menu**: the standard edit items are grouped into **submenus** (Select / Find / Go To / Lines / Convert / Format), so the top level stays at 12 rows — undo/redo, cut/copy/paste, the six groups, and save — instead of 30 flat items. Inside are the VS Code staples: select all occurrences, go to definition / find references / rename symbol, move-copy-delete lines, indent, transform case, add cursor above/below, line and block comments, format document or selection, fold and unfold. **With a text selection, a "DeepSeek Harness" submenu appears at the very top**: Add to Conversation, Ask DSH…, Explain / Fix / Refactor this code, Generate Unit Tests, Add Comments, Review this code, Copy as Quote. Everything except "Copy as Quote" only **inserts the quote or instruction into the DSH composer — it never sends for you**, so you can finish the message and send it yourself. The menu supports two levels (hover or arrow keys to expand, Escape closes one level at a time) and exposes `registerEditorMenuContribution` so other plugins can append their own items. The menus are **text only** (no icons); only expandable submenus carry a small chevron at the end of the row.
- **Inline completion**: ghost-text suggestions at the cursor, served by a real model or a local fallback;
  cycle through candidates and accept by block, by line, or by word. Context comes from the current file
  and a local retrieval index that never leaves the workspace directory.
  See [docs/inline-completion.md](docs/inline-completion.md) for implementation and verification status.
  Note: host-side code loads at process start, so **restart the app** after changes (a page reload is enough for the client side).
- **Sync and restore**: workspace file changes stream to the UI, while reload restores views, expanded directories, panels, and layout (file tabs are not restored across sessions).

AIDE mounts through DSH's `shell.overlay`, `main`, `sidebar.panellist`, and `settings.section` extension points
(`main` and `sidebar.panellist` are registered as a pair and swap places when the side panel is collapsed). It does not
replace or disable `ui-layout`.

## Performance

- **Terminal startup**: opening the terminal panel pre-warms the default shell on the host (`TerminalManager.prewarm`, reclaimed
  after 90 seconds if nobody claims it). Creating a terminal then adopts that shell, whose replay buffer already holds the
  prompt. On this machine `pwsh` needs about 530 ms from spawn to accepting commands; a pre-warmed create costs about 2 ms on
  the host. Create/close/rename each issue a single request, and the panel plus every opened xterm instance stay mounted.
  Deployments that do not want the extra idle shell can disable prewarming with `DWV_TERMINAL_PREWARM=0` (creation still works).
- **Rendering and IO**: file-change pushes only update tab state when something actually changed; resizer drags move CSS
  variables and persist the layout once on pointer-up; the Markdown outline and the Git commit graph are memoized; Monaco
  models are evicted LRU (open/dirty files kept, limit 12); TextMate grammars are installed once per language and files over
  3000 lines or 200 KB fall back to the built-in tokenizer.
- **Cold-start code splitting**: the PDF and Word render stacks are only needed when such a file is opened, so they now live
  in DSH client chunks (`lib/client.pdf.js` 487 KB, `lib/client.docx.js` 243 KB) loaded same-origin on first preview. The main
  bundle drops from 2.65 MB to **1.75 MB** (gzip 584 KB → 375 KB) and V8 compile from 28 ms to 18 ms; neither chunk is
  downloaded unless you open a PDF or Word document.
- **Completion**: request bodies carry only the cursor window (about 20 KB for a 1 MB document, with the prompt byte-identical
  to sending the whole document); response headers no longer wait for the retrieval index; snippets are read by line range and
  multiple hits in one file share a single scan.
- **Git**: `gitRoot` and rev-parse results are cached, bringing a Git panel refresh from five `git.exe` invocations to two on the
  warm path; committing reuses the status the host returns and only refetches the log.
- **Reproducible baseline**: `pnpm perf` measures terminal startup (spawn / first byte / interactive readiness for three shells,
  plus "warm ready / adopting the warm shell / waiting without prewarm"), client bundle size and compile cost (including the
  on-demand chunks), and host entry load cost, writing `perf-results/baseline.json` (gitignored). Measured here: adopting the
  warm shell takes about 2 ms, while clicking "new terminal" without prewarm needs about 100–160 ms to a prompt (the shell's
  own startup is absorbed by the time the panel is open or the button is hovered). Current bundle numbers: main
  `lib/client.js` 1.75 MB (about 375 KB gzip, about 18 ms V8 compile), host entry import about 37 ms.
- **No native/Rust addon**: the host's hot spots are Windows process creation (about a 44 ms floor per `git.exe` or shell) and
  protocol overhead, not JavaScript computation. Pure JS optimizations capture most of the win, while a native addon would need
  to cover both the Electron and Node ABIs with per-platform prebuilds, which is not worth the install size and distribution cost.

## Demo

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/screenshots/explorer.png" width="800" alt="Explorer and Monaco editor">
  <br><em>Explorer and Monaco editor</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/PrismScopes/dsh-aide/main/assets/screenshots/source-control.png" width="800" alt="Source control and commit graph">
  <br><em>Source control and commit graph</em>
</p>

<p align="center">
  <img src="https://pic1.imgdb.cn/i/034GkZFU8ULHsWgFio93Lw.png" width="800" alt="terminal">
  <br><em>terminal</em>
</p>


## Installation

```bash
dsh plugin --profile web add dsh-aide
```

### First terminal installation

The terminal uses `node-pty`. On the first install, pnpm 11 may block its build script, so `dsh plugin ... add` can report `Ignored build scripts` and end with an error. This is an expected safety check: the dependency has already been written to the profile. Run this on the machine that runs DSH:

```bash
cd ~/.dsh/profiles/web
pnpm approve-builds --all
```

This approves the `node-pty` build and completes the installation. Restart `dsh web` afterwards. If the terminal still reports that `node-pty` cannot load, run:

```bash
cd ~/.dsh/profiles/web
pnpm approve-builds --all && pnpm rebuild node-pty
```

pnpm can also delay versions published less than 24 hours ago. Retry after the waiting period, or use DSH's "Update now" action when it is offered.

### Version requirement

PDF and Word previews load their render stacks through DSH client-module on-demand chunks (`require.async`), which requires DSH
`0.2.1-rc.2` or newer (declared in `dsh.compatibility`). On older hosts those two previews report that on-demand loading is not
supported; every other feature keeps working.

## Listings and promotion

- **GitHub**: [PrismScopes/dsh-aide](https://github.com/PrismScopes/dsh-aide) — the repo carries `dsh-plugin` / `deepseek-harness` topics, so several plugin directories index it automatically.
- **npm**: `dsh-aide` — indexed once published; `package.json` already declares the `dsh.bundle` manifest, exact SemVer, and `cordis.patch.yml`.
- **DSH Plugin Hub**: [dshpluginhub.ai](https://dshpluginhub.ai) — hourly npm sync; repos with a `dsh.bundle` manifest and the `dsh-plugin` topic appear as source-only first, then upgrade after the npm release.
- **dsh.so market**: [submission page](https://www.dsh.so/zh/submit/) — paste the repository or package name for schema validation and a security scan.
- **awesome-dsh-plugin**: [community catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — one `data/plugins/<owner>__<repo>.yml` per plugin.

Submitted listings (under review / sync): [awesome-dsh-plugins #145](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/145) · [dshopen.org #17](https://github.com/polang233/dsh-plugin-index/issues/17) · [dsh-plugin.org #346](https://github.com/dshplugin/dsh-plugin-hub/issues/346).

> Clients with custom plugin-index support can add `https://github.com/PrismScopes/dsh-aide` directly.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+E` | Open Explorer |
| `Ctrl+Shift+F` | Open Search and focus the input |
| `Ctrl+Shift+H` | Open Search with the replace row expanded |
| `F4` / `Shift+F4` | Next / previous search result |
| `Ctrl+Shift+G` | Open Source Control |
| `Ctrl+S` | Save the active file |
| `Ctrl+Alt+B` | Toggle the DSH conversation panel |
| `Ctrl+\`` | Show or hide the terminal |
| `Ctrl+Shift+\`` | Create a terminal |
| `Tab` | Accept the whole suggestion |
| `Ctrl+Right` | Accept the next segment |
| `Ctrl+Alt+Right` | Accept the next line |
| `Alt+[` / `Alt+]` | Previous or next candidate |

## Security

The host accepts only paths relative to the active DSH session workspace and rejects traversal and symlink escape. Saves use revision checks and atomic replacement. Git and ripgrep run with argument arrays rather than shell-concatenated commands. The terminal accepts same-origin loopback requests only, starts in the session workspace, and removes API keys, tokens, secrets, and similar environment variables.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm perf    # performance baseline (terminal startup / client bundle / host entry)
```

Requires Node.js `^22.19 || >=24`, pnpm 11.7, system Git, and the native build prerequisites for `node-pty` when no prebuild is available.

## Contributors

- **Author / maintainer**: [PrismScopes](https://github.com/PrismScopes)
- **Origin**: AIDE started from [tingfeng347/dsh-vscode-workbench](https://github.com/tingfeng347/dsh-vscode-workbench) (MIT); thanks to the original author for the foundation. This repository keeps the MIT license and the full commit history.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
