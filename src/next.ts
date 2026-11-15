/**
 * 子路径入口：request-only 形态（只有 `Request`，响应尚未产生）。
 * Next.js middleware 是典型；任何拿不到响应状态的前置钩子都能用。
 */
export { requestMiddleware, type RequestProbe } from "./adapters/request";
