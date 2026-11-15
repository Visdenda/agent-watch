/**
 * 子路径入口：`context + next()` 形态的中间件（Hono 是典型；任何提供
 * `{ req: { raw }, res, executionCtx }` 的上下文都适用）。
 */
export { contextMiddleware } from "./adapters/context";
