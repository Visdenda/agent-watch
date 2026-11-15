/**
 * 子路径入口：Node `(req, res, next)` 形态的中间件（Express / Koa 中间件包装 / Polka / Nest）。
 * 名字描述请求形状，不绑定框架：同一份实现可挂任何 `(req, res, next)` 链。
 */
export { nodeMiddleware } from "./adapters/node";
