/**
 * @visdenda/agent-watch：面向代理的站点能力。
 *
 * 入口按「你要在哪里接」拆开，根入口只有核心工厂与协议类型：
 * - `@visdenda/agent-watch`：`createAgentWatch({ token })` + 协议类型/名单工具
 * - `@visdenda/agent-watch/workers`：Fetch 形态（Workers / Bun / Deno / Edge）
 * - `@visdenda/agent-watch/node`：Node `(req, res, next)` 形态
 * - `@visdenda/agent-watch/hono`：`context + next()` 形态
 * - `@visdenda/agent-watch/next`：request-only 形态（Next middleware）
 * - `@visdenda/agent-watch/markdown`：Markdown 内容协商
 *
 * 零运行时依赖；包内不内置 UA 名单（匹配只在服务端发生，新增爬虫无需升级包）。
 * 非 JS 栈（PHP / Python / Go / Ruby / Java）直接走 `POST /v1/probe`，不需要本包。
 */
export * from "./probe";
