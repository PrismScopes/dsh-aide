/**
 * pdfjs-dist 只为部分构建随包提供类型声明，压缩版（build/pdf.min.mjs）没有。
 * 它的 API 与 legacy 构建完全一致，直接借用那份声明 —— 这样既拿到类型，
 * 又保住了压缩版带来的体积收益（783KB → 344KB）。
 */
declare module 'pdfjs-dist/build/pdf.min.mjs' {
  export * from 'pdfjs-dist/legacy/build/pdf.mjs'
}
