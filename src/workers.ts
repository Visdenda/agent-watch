/**
 * 子路径入口：Fetch API 形态（`Request → Response`）。Cloudflare Workers、Bun.serve、
 * Deno、Vercel/Netlify Edge 都是这一套；`wrapFetch(config, handler)` 是
 * `createAgentWatch(config).wrapFetch(handler)` 的一步式便捷入口。
 */
export { wrapFetch } from "./adapters/fetch";
