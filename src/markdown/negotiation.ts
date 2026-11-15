/**
 * Markdown for Agents 内容协商（FR-AEO-27；自 apps/web/worker 泛化，零依赖）。
 *
 * 对齐 Cloudflare content_converter 的响应契约：
 * text/markdown + Vary 合并 + x-markdown-tokens（估算）。content-signal **只保留
 * 不注入**：它是站点主的训练/输入授权声明，缺省补 `ai-train=yes` 等于替用户改政策
 * （与 robots.txt 的 Content-Signal 矛盾——本站就因此在线上自相矛盾过）；原响应
 * 没声明就是没声明，转换不代为表态。失败一律回退原 HTML，页面永远不断；
 * 本模块不抓取、不缓存，只做响应变换。
 */

import { buildMarkdownDocument } from "./html-to-markdown";

export type { MarkdownDocument } from "./html-to-markdown";
export {
  buildMarkdownDocument,
  contentRoot,
  extractHead,
  fragmentToMarkdown,
  stripChrome,
} from "./html-to-markdown";

/** HTML 转换预算（值域同 spec「数值默认」：2 MB）。 */
export const MARKDOWN_HTML_BUDGET_BYTES = 2_000_000;

/** 单次转换超时（纯字符串处理，2 秒已含 20 倍余量）。 */
export const MARKDOWN_TIMEOUT_MS = 2_000;

export type MarkdownOptions = {
  /** 参与协商的路径前缀；缺省 = 全部页面（仍受 excludePatterns 约束）。`"/"` 只匹配首页。 */
  markdownPaths?: ReadonlyArray<string>;
  /** 排除路径（默认排除 API / Next 资源 / CF 内部路径与静态扩展名）。 */
  excludePatterns?: ReadonlyArray<RegExp>;
  budgetBytes?: number;
  /**
   * 响应体读取超时。**只约束读取**：HTML→Markdown 是同步字符串处理，
   * 定时器无法在同步执行中抢占，转换本身不会被这个超时打断。
   */
  timeoutMs?: number;
  /**
   * 响应缓存（默认关闭）：有 `caches` 的运行时把 200 的转换结果按 URL 缓存，
   * TTL 内直接返回，避免重复转换。写缓存前去掉 `set-cookie`、保留 `Vary: Accept`
   * 并写 `max-age, private`；origin 标记个性化（`set-cookie`/`private`/`vary: cookie`）时不缓存。
   */
  cache?: { ttlMs: number } | null;
};

/** 默认排除（EARS #3）：内部前缀 + 静态扩展名。 */
export const DEFAULT_EXCLUDE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/api(?:\/|$)/,
  /^\/_next\//,
  /^\/cdn-cgi\//,
  /\.(?:js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|json|xml|txt|map)$/i,
];

export type ResolvedMarkdownOptions = {
  markdownPaths: ReadonlyArray<string> | undefined;
  excludePatterns: ReadonlyArray<RegExp>;
  budgetBytes: number;
  timeoutMs: number;
  cache: { ttlMs: number } | null;
};

export const resolveMarkdownOptions = (options?: MarkdownOptions): ResolvedMarkdownOptions => ({
  markdownPaths: options?.markdownPaths,
  excludePatterns: options?.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
  budgetBytes: options?.budgetBytes ?? MARKDOWN_HTML_BUDGET_BYTES,
  timeoutMs: options?.timeoutMs ?? MARKDOWN_TIMEOUT_MS,
  cache:
    options?.cache && Number.isFinite(options.cache.ttlMs) && options.cache.ttlMs > 0
      ? { ttlMs: options.cache.ttlMs }
      : null,
});

/** 跟踪参数不参与缓存身份：否则每个 `?utm_*` 落地页都各存一份，命中率接近 0。 */
const TRACKING_PARAM = [/^utm_/, /^gclid$/, /^fbclid$/, /^msclkid$/, /^yclid$/, /^_hs/];

/**
 * markdown 缓存键（spec probe-v2 #13）：`url?__aw_md=1`（去掉跟踪参数、参数排序）。
 * 不用 `#fragment`：片段不保证参与 Cache API 的 cache key，会与 HTML 响应撞键。
 */
export const markdownCacheKey = (url: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.delete("__aw_md");
  for (const name of Array.from(parsed.searchParams.keys())) {
    if (TRACKING_PARAM.some((pattern) => pattern.test(name))) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();
  parsed.searchParams.set("__aw_md", "1");
  parsed.hash = "";
  return parsed.href;
};

/**
 * EARS #3：显式 markdownPaths 时按前缀命中；否则全站，但排除静态资源与内部路径。
 * 前缀按「整段」匹配（`/docs` 不会命中 `/docs2`），所以 `"/"` 只匹配首页
 * —— 想全站就不要传 markdownPaths。`["/", "/docs"]` 是「首页 + /docs」。
 */
export const isMarkdownPagePath = (pathname: string, options?: MarkdownOptions): boolean => {
  const resolved = resolveMarkdownOptions(options);
  if (resolved.excludePatterns.some((pattern) => pattern.test(pathname))) return false;
  if (resolved.markdownPaths === undefined) return true;
  return resolved.markdownPaths.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

const maxQuality = (accept: string, mime: string): number | null => {
  let best: number | null = null;
  for (const part of accept.split(",")) {
    const segments = part.split(";");
    if (segments[0]?.trim().toLowerCase() !== mime) continue;
    let q = 1;
    for (let i = 1; i < segments.length; i++) {
      const match = /^q=([0-9]*\.?[0-9]+)$/.exec(segments[i]?.trim().toLowerCase() ?? "");
      if (match) {
        const value = Number(match[1]);
        q = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;
      }
    }
    best = best === null ? q : Math.max(best, q);
  }
  return best;
};

/**
 * EARS #1–#2：GET、无 Range、显式 text/markdown 且 q>0、且不比 text/html 低。
 * 浏览器导航头（含通配符但无显式 text/markdown）不会命中。
 */
export const wantsMarkdown = (request: Request): boolean => {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept");
  if (!accept || !accept.toLowerCase().includes("text/markdown")) return false;
  if (request.headers.has("range")) return false;
  const markdownQ = maxQuality(accept, "text/markdown");
  if (markdownQ === null || markdownQ <= 0) return false;
  const htmlQ = maxQuality(accept, "text/html");
  return htmlQ === null || markdownQ >= htmlQ;
};

/** EARS #6：Vary 合并（已有 Accept 不重复追加，大小写不敏感）。 */
export const mergeVary = (existing: string | null): string => {
  if (!existing) return "Accept";
  return existing
    .toLowerCase()
    .split(",")
    .some((value) => value.trim() === "accept")
    ? existing
    : `${existing}, Accept`;
};

/**
 * 预算内的响应体读取：没有 `content-length` 时不能先整包 `text()` 再判断 ——
 * 一个超大 chunked HTML 会先把内存吃满再被丢弃。流式读取，超预算立刻 cancel。
 */
const readWithinBudget = async (response: Response, budget: number): Promise<string | null> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > budget) return null;
  if (!response.body) {
    try {
      const text = await response.text();
      return new TextEncoder().encode(text).length > budget ? null : text;
    } catch {
      return null;
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budget) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/**
 * EARS #5–#8：HTML 响应转 markdown；非 200 / 非 HTML / 超预算 / 解析失败返回 null。
 * markdown 分支固定 no-store：防 CDN 把 markdown 变体存进 HTML 缓存。
 */
export const toMarkdownResponse = async (
  htmlResponse: Response,
  pageUrl: string,
  options?: MarkdownOptions,
): Promise<Response | null> => {
  const resolved = resolveMarkdownOptions(options);
  if (htmlResponse.status !== 200) return null;
  const contentType = htmlResponse.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return null;
  const html = await readWithinBudget(htmlResponse, resolved.budgetBytes);
  if (html === null) return null;
  let doc;
  try {
    doc = buildMarkdownDocument(html, pageUrl);
  } catch {
    return null;
  }
  if (!doc) return null;

  const headers = new Headers(htmlResponse.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("vary", mergeVary(htmlResponse.headers.get("vary")));
  headers.set("x-markdown-tokens", String(doc.tokens));
  headers.set("cache-control", "no-store");
  for (const stale of [
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "content-range",
    "etag",
    "last-modified",
    "age",
    "expires",
  ]) {
    headers.delete(stale);
  }
  // EARS #8 / 边界 #8：content-signal 只保留不注入——已声明原样透传，未声明
  // 保持未声明（不代站点声明任何训练/输入授权）。
  return new Response(doc.markdown, { status: 200, headers });
};
