/**
 * DOCX 渲染栈（按需 chunk）。
 *
 * docx-preview 及其 jszip/pako 依赖都只服务于 Word 预览，全部留在 chunk 里；
 * 主 bundle 不再包含它们（构建配置把 jszip 指向 UMD 压缩版）。
 */
import { renderAsync } from 'docx-preview'

export { renderAsync }
