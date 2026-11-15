/**
 * Markdown 协商中间件（FR-AEO-27 T-b）：fetch 包装器 / 框架无关 `(req, next)`。
 *
 * 语义（EARS #3–#7）：
 * - 不命中协商：原请求直通 `next`，零额外开销；
 * - 命中：只对同一 URL 做**一次**内部重取（`Accept: text/html`，天然防递归），
 *   转换成功返回 markdown；转换失败/超时回退这次内部 HTML 响应（状态码不变）。
 */

import {
  isMarkdownPagePath,
  markdownCacheKey,
  mergeVary,
  resolveMarkdownOptions,
  toMarkdownResponse,
  wantsMarkdown,
  type MarkdownOptions,
} from "./negotiation";

export type MarkdownNext = (request: Request) => Promise<Response>;

/**
 * 最小 Cache API 结构（不引 DOM/Workers 类型）：只有 `caches.default` 存在时启用。
 * `caches.default` 与站点 CDN 缓存共用，必须用独立键（`__aw_md=1`）避免撞键。
 */
type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

const defaultCache = (): CacheLike | null => {
  const caches = (globalThis as { caches?: { default?: CacheLike } }).caches;
  return caches?.default ?? null;
};

/**
 * 可共享性判定：缓存命中会把副本原样回给客户端，所以 origin 明确个性化的响应
 * 一份都不能存 —— 否则 TTL 内某个登录用户的正文会发给所有人。
 * `set-cookie` / `cache-control: private|no-store` / `vary: cookie|*` 都算个性化信号。
 */
const isShareable = (origin: Response): boolean => {
  if (origin.headers.has("set-cookie")) return false;
  const cacheControl = (origin.headers.get("cache-control") ?? "").toLowerCase();
  if (cacheControl.includes("private") || cacheControl.includes("no-store")) return false;
  const vary = (origin.headers.get("vary") ?? "").toLowerCase();
  return !vary.split(",").some((value) => value.trim() === "cookie" || value.trim() === "*");
};

/**
 * 写入缓存的副本（spec probe-v2 #13）：转换结果自带 `no-store`，Cache API 会拒存。
 * `max-age` 是 `.put()` 唯一能表达 TTL 的手段；`private` 阻止下游 CDN 存储同一份响应。
 * **必须保留 `Vary: Accept`**：命中副本会直接回给客户端，缺它的 `text/markdown`
 * 会被共享缓存按裸 URL 存下来喂给浏览器（本包审计规则判 fail 的正是这个形态）。
 * 失败静默——缓存是优化，不是正确性。
 */
const storeInCache = async (
  cache: CacheLike,
  key: string,
  response: Response,
  ttlMs: number,
): Promise<void> => {
  try {
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    headers.set("vary", mergeVary(response.headers.get("vary")));
    headers.set("cache-control", `max-age=${Math.max(1, Math.floor(ttlMs / 1000))}, private`);
    const stored = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    await cache.put(new Request(key), stored);
  } catch {
    // 缓存写入失败不影响本次响应。
  }
};

export type MarkdownHandler = ((request: Request, next: MarkdownNext) => Promise<Response>) & {
  /** fetch 运行时适配（Workers / Bun / Deno / * Edge）：`export default handler.wrapFetch((req, env) => env.ASSETS.fetch(req))`。 */
  wrapFetch<TEnv>(
    fetchHandler: (request: Request, env: TEnv) => Promise<Response>,
  ): (request: Request, env: TEnv) => Promise<Response>;
};

const withTimeout = async <T>(promise: Promise<T | null>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const pathnameOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
};

export const markdownNegotiation = (options?: MarkdownOptions): MarkdownHandler => {
  const resolved = resolveMarkdownOptions(options);
  const cache = resolved.cache ? defaultCache() : null;
  let warned = false;

  const handler = (async (request: Request, next: MarkdownNext): Promise<Response> => {
    if (!wantsMarkdown(request) || !isMarkdownPagePath(pathnameOf(request.url), resolved)) {
      return next(request);
    }
    const cacheKey = cache ? markdownCacheKey(request.url) : null;
    if (cache && cacheKey) {
      try {
        const hit = await cache.match(new Request(cacheKey));
        if (hit) return hit;
      } catch {
        // 缓存读失败按未命中处理。
      }
    }

    // 内部重取：同一 URL、Accept 改写 text/html（EARS #4）。
    const headers = new Headers(request.headers);
    headers.set("accept", "text/html");
    const internal = new Request(request.url, { method: "GET", headers });
    const htmlResponse = await next(internal);

    // 转换会消费响应体；用 clone 转换，失败时才能把**完整**的 HTML 回退给调用方
    // （直接读原响应再回退，拿到的是已消费的空 body）。
    const converted = await withTimeout(
      toMarkdownResponse(htmlResponse.clone(), request.url, resolved),
      resolved.timeoutMs,
    );
    if (converted) {
      // 只缓存 200 且 origin 未声明确认个性化的响应；clone 后再改写缓存副本，
      // 返回给客户端的响应保持原样。
      if (cache && cacheKey && converted.status === 200 && isShareable(htmlResponse)) {
        void storeInCache(cache, cacheKey, converted.clone(), resolved.cache?.ttlMs ?? 0);
      }
      return converted;
    }
    if (!warned) {
      warned = true;
      console.warn("[agent-watch] markdown conversion failed; serving HTML for this instance");
    }
    return htmlResponse;
  }) as MarkdownHandler;

  handler.wrapFetch = (fetchHandler) => (request, env) =>
    handler(request, (internalRequest) => fetchHandler(internalRequest, env));

  return handler;
};
