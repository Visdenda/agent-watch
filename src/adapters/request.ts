import { createAgentWatch, type AgentWatchConfig, type WaitUntil } from "../probe";

/**
 * Request-only middleware helper（EARS #17）。
 *
 * 只上报请求本身，返回 undefined —— 调用方（如 Next.js middleware）仍自行返回响应。
 * 此时响应尚未产生，所以不带 `status`，读面按 `no-status-source` 展示。
 *
 * 需要把上报挂到运行时的延长执行钩子时传第二个参数：不 await 的 fetch 在响应
 * 返回后可能被截断，挂上去才能保证上报真正发出。
 *
 * ```ts
 * const probe = requestMiddleware({ token: "vdc_..." });
 * export function middleware(request: NextRequest, event: NextFetchEvent) {
 *   probe(request, (task) => event.waitUntil(task));
 *   return NextResponse.next();
 * }
 * ```
 */
export type RequestProbe = (request: Request, waitUntil?: WaitUntil) => void;

export const requestMiddleware = (config: AgentWatchConfig): RequestProbe => {
  const watch = createAgentWatch(config);
  return (request, waitUntil) =>
    watch.fromRequest(request, waitUntil === undefined ? undefined : { waitUntil });
};
