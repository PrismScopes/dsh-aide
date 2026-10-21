/**
 * 对外展示的插件版本。
 *
 * 客户端 bundle 不能直接 import package.json（tsconfig 没开 resolveJsonModule，打包后也没有
 * 运行时文件系统），所以这里留一个常量；**必须与 package.json 的 version 保持一致** ——
 * tests/package.spec.ts 会直接比较两处，发版时漏改会让测试失败。
 *
 * 设置页「关于与诊断」与补全请求的 environment.extensionVersion 都从这里取，不再各写一份。
 */
export const WORKBENCH_VERSION = '0.5.2'
