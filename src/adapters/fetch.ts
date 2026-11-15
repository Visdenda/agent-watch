import { createAgentWatch, type AgentWatchConfig, type FetchHandler } from "../probe";

/**
 * 请求模型一：**Fetch API**（`Request` → `Response`）。一套代码覆盖
 * Cloudflare Workers、Bun.serve、Deno、Vercel Edge、Netlify Edge、Astro、SvelteKit。
 *
 * response-aware：先跑 handler，再带真实 status 上报；第三个参数是 Worker 的 ctx 时，
 * 上报挂到 `ctx.waitUntil`，既不拖慢响应，也不会在实例结束后被截断。没有 ctx（Bun/Deno）
 * 就退回不 await 的 fire-and-forget。零依赖，任何 `export default { fetch }` 都吃。
 *
 * ```ts
 * export default {
 *   fetch: wrapFetch({ token: "vdc_..." }, (request, env, ctx) => env.ASSETS.fetch(request)),
 * };
 * ```
 */
export const wrapFetch = <H extends FetchHandler>(config: AgentWatchConfig, handler: H): H =>
  createAgentWatch(config).wrapFetch(handler);
