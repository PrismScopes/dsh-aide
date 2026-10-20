/**
 * PDF 渲染栈（按需 chunk）。
 *
 * 只导出 pdfjs 命名空间；`GlobalWorkerOptions.workerSrc` 仍由 documentPreview 在运行时设置，
 * worker 脚本继续走宿主路由 `/dsh-vscode/pdfjs/worker.mjs`（与拆分前一致）。
 */
import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs'

export { pdfjs }
