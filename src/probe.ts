/**
 * Server-side crawler probe（crawler-directory T-i / EARS #14–#22；probe v2 0.4）。
 *
 * 设计前提：匹配只在服务端发生，包内不内置 UA 名单 —— 新增爬虫永远不需要
 * 用户升级包。这里只负责把「一个请求」变成一次 fire-and-forget 的 POST。
 *
 * v2（spec probe-v2）：
 * - 载荷补 `ref/utm/neg/dur/country/colo` 与 `x-agent-watch` 版本头；
 * - UA 超长截断而非丢弃；`x-forwarded-for` 仅在 `trustProxy: true` 时可信；
 * - AI 引荐命中的浏览器导航不再被「跳过浏览器导航」吃掉；
 * - 可选批量上报（默认关闭），失败丢弃不重试。
 *
 * 所有字段的上限必须 ≤ 服务端 schema（`probePayloadSchema`）：超限不是被截断，
 * 而是整条事件 400，而 SDK 又把错误吞掉了 —— 外部症状是「装了、没报错、没数据」。
 * 因此 path/ip 与 ua/ref 一样在客户端收口。
 */

import { nowMs } from "./timing";

export type WaitUntil = (promise: Promise<unknown>) => void;

export type BatchConfig = {
  /** 缓冲到多少条立即发送（含）。上限 50（服务端批量 schema）。 */
  maxEvents: number;
  /** 距首条多久兜底 flush（毫秒）。上限 10000（waitUntil 预算）。 */
  flushMs: number;
};

export type AgentWatchConfig = {
  /**
   * 站点采集令牌（`vdc_...`）。唯一必填项；缺失是接错线，直接抛配置错误。
   * 线路字段仍叫 `site`（协议冻结），配置层叫 `token`：它是令牌，不是站点 id 或域名。
   */
  token: string;
  /** 采集端 origin；缺省 https://visdenda.com。 */
  endpoint?: string;
  /** 上报首跳客户端 IP（ASN 异常识别的前提）；默认开启。 */
  sendIp?: boolean;
  /** 跳过现代浏览器主动导航（Sec-Fetch 文档导航）；默认开启。 */
  skipBrowserNavigations?: boolean;
  /** 上报超时；默认 2 秒（探针可丢弃，不重试）。 */
  timeoutMs?: number;
  /**
   * 仅当站点确实在反向代理之后时开启：允许把 `x-forwarded-for` 首段、
   * `x-real-ip` / `true-client-ip` / `fly-client-ip` 当作客户端 IP，
   * 并把 `x-forwarded-host` 当作公开 Host（Web Bot Auth 的 `@authority`）。
   * 缺省 false（只认 `cf-connecting-ip` 与原始 Host），否则任意客户端都能用请求头
   * 伪造 IP/Host、污染 ASN 聚合与验签。Vercel / Netlify / nginx 前置属于「确实在代理之后」。
   */
  trustProxy?: boolean;
  /** 静态回退国家码（无平台国家头的运行时）；`ProbeInput.country` 优先。 */
  country?: string;
  /** 静态回退边缘节点三字码（无 `cf-ray` 的运行时）；`ProbeInput.colo` 优先。 */
  colo?: string;
  /** 批量上报；缺省关闭（缓冲在 isolate 回收时会丢数据，批量是成本优化不是正确性）。 */
  batch?: BatchConfig;
  /**
   * 上报失败回调（网络错误、超时、非 2xx），默认静默。回调自身抛错会被吞掉：
   * 观测不能反过来打断页面。`check()` 有显式返回值，不经过这里。
   */
  onError?: (failure: ProbeFailure) => void;
  /**
   * 首次上报失败时 `console.warn` 一次（默认关闭）；提供 `onError` 时不再 warn。
   * 用于「装了、没报错、没数据」的首次接线排查。
   */
  debug?: boolean;
  /** 测试/非标准运行时的 fetch 注入点。 */
  fetch?: typeof fetch;
};

/**
 * 入站 Web Bot Auth 头（RFC 9421）。与服务端 `webBotAuthHeadersSchema` 同口径，
 * 但 SDK 零依赖、不引私有包，所以类型在本地定义。
 */
export type WebBotAuthHeaders = {
  signatureAgent: string;
  signatureInput: string;
  signature: string;
};

export type ProbeInput = {
  ua?: string | null;
  path?: string | null;
  status?: number;
  ip?: string | null;
  /** 显式覆盖请求 Host（authority）；`null` 表示不带，缺省从 `host` 头或 URL 取。 */
  host?: string | null;
  /** 显式覆盖 Web Bot Auth 头；`null` 表示不带，缺省从请求头取。 */
  webBotAuth?: WebBotAuthHeaders | null;
  /** 完整请求 URL（用于取 `utm_source`）；缺省只从 headers 取 referer。 */
  url?: string | null;
  headers?: HeadersInit;
  /** 本次响应的内容协商结果（wrapFetch/next 之外的调用方可显式传）。 */
  neg?: "html" | "markdown";
  /** 服务端可测的 handler 耗时（毫秒）。 */
  dur?: number;
  /** 单次调用的国家/边缘覆盖（优先于请求头与配置）。 */
  country?: string | null;
  colo?: string | null;
  /** Cloudflare Worker / Next middleware 提供的延长执行钩子。 */
  waitUntil?: WaitUntil;
};

export type ProbePayload = {
  /** 协议版本：0.5 起为 2；缺省平台按 1 处理（服务端只加字段，不拒绝老客户端）。 */
  v: 2;
  site: string;
  ua: string;
  path: string;
  status?: number;
  ip?: string;
  ref?: string;
  utm?: string;
  neg?: "html" | "markdown";
  dur?: number;
  country?: string;
  colo?: string;
  /**
   * 请求 Host（authority）。只在请求带 Web Bot Auth 签名头时上报：缺省未签名是常态，
   * 字段体积不该摊到每个事件上。`@authority` 验签用的就是原始 Host。
   */
  host?: string;
  /** 入站 Web Bot Auth 头；三头齐全且未超限才上报（缺省=未签名，不等于伪造）。 */
  webBotAuth?: WebBotAuthHeaders;
};

/** 批量缓冲条目：事件在入队时序列化一次，flush 时按字节切包并直接拼请求体。 */
type BufferedEvent = { body: string; bytes: number };

/**
 * 一次上报失败（网络/超时/非 2xx）。`status` 只在服务端回了非 2xx 时存在；
 * `error` 只在 fetch 抛错或超时中断时存在；批量失败带 `events` 条数。
 */
export type ProbeFailure = {
  path: "/v1/probe" | "/v1/probe/batch";
  status?: number;
  error?: unknown;
  events?: number;
};

/** 自检结果：`invalid` = token 无效/站点未验证；`unreachable` = 网络或服务端故障。 */
export type ProbeCheckResult =
  | { valid: true }
  | { valid: false; reason: "invalid" | "unreachable" };

export type FetchHandler = (request: Request, ...args: never[]) => Response | Promise<Response>;

export type AgentWatch = {
  /** 直接上报一个已解析的请求。 */
  probe(input: ProbeInput): void;
  /** 从 fetch Request 取 UA/path/IP（request-only，无 status）。 */
  fromRequest(
    request: Request,
    options?: {
      status?: number;
      neg?: "html" | "markdown";
      dur?: number;
      waitUntil?: WaitUntil;
    },
  ): void;
  /**
   * fetch 包装（response-aware）：第二个参数带 `waitUntil`（Worker 的 ctx）就挂上去，
   * 没有就退回不 await 的 fire-and-forget。Workers / Bun / Deno / Vercel Edge / Netlify Edge
   * 都是同一套 Request→Response，所以不按平台拆适配器。
   */
  wrapFetch<H extends FetchHandler>(handler: H): H;
  /** 立即发送缓冲中的批量事件（batch 关闭时为 no-op）。 */
  flush(): Promise<void>;
  /**
   * 自检：确认 token 有效且站点已验证（`POST /v1/probe/check`）。
   * 令牌拼错/endpoint 配错时，探针本身只会静默 204/404，调用一次即可定位。
   * 需要区分「token 无效」与「采集端不可达」时用这个；只关心能否通过就用 `verify()`。
   */
  check(): Promise<ProbeCheckResult>;
  /** 自检的布尔便捷入口（等价于 `(await check()).valid`），适合启动时做一次接线门。 */
  verify(): Promise<boolean>;
};

const DEFAULT_ENDPOINT = "https://visdenda.com";
const REPORT_TIMEOUT_MS = 2_000;
/** 与服务端 schema 一致：超长不是截断是整条 400。 */
const MAX_UA_LENGTH = 512;
const MAX_PATH_LENGTH = 512;
const MAX_IP_LENGTH = 45;
const MAX_REF_LENGTH = 1_024;
const MAX_UTM_LENGTH = 64;
const MAX_DURATION_MS = 600_000;
/** 与服务端 schema 对齐（`host.max(253)` / `webBotAuthHeadersSchema`）：超限整条 400。 */
const MAX_HOST_LENGTH = 253;
const MAX_SIGNATURE_AGENT_LENGTH = 1_024;
const MAX_SIGNATURE_INPUT_LENGTH = 4_096;
const MAX_SIGNATURE_LENGTH = 4_096;
/** 服务端批量上限（probe-v2 A.2）：>50 条整批 400。 */
export const MAX_BATCH_EVENTS = 50;
/** 服务端批量体积上限：32 KB；客户端按此拆批，避免整批 413。 */
export const MAX_BATCH_BODY_BYTES = 32 * 1024;
/** flushMs 上限：waitUntil 的兜底定时器要比 Worker 的 30s 执行预算短。 */
const MAX_FLUSH_MS = 10_000;
/** 请求体编码器（`TextEncoder` 在 Workers 与 Node 18+ 都是全局）。 */
const encoder = new TextEncoder();

/**
 * 版本号由构建注入（build.mjs 的 esbuild define）；源码直跑（仓内）时退回 dev 标记。
 * Workers 运行时读不到 `package.json`，不能在运行时读取。
 */
declare const __AGENT_WATCH_VERSION__: string | undefined;
const VERSION = typeof __AGENT_WATCH_VERSION__ === "string" ? __AGENT_WATCH_VERSION__ : "0.0.0-dev";

/**
 * AI 引荐域名名单（与服务端 `isAiReferrerHost` 同口径）：
 * SDK 发布到 npm 且零依赖，不能引私有包；漏项只会导致该次导航被跳过，不会误判。
 */
export const AI_REFERRER_HOSTS: ReadonlyArray<string> = [
  "chatgpt.com",
  "chat.openai.com",
  "chat.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "grok.com",
  "meta.ai",
  "deepseek.com",
  "mistral.ai",
  "kagi.com",
  "phind.com",
  "you.com",
  "poe.com",
];

export const isAiReferrerHost = (host: string | null | undefined): boolean => {
  if (typeof host !== "string" || host.length === 0) return false;
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return AI_REFERRER_HOSTS.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
};

const readHeader = (headers: HeadersInit | undefined, name: string): string | null => {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name);
    return match?.[1] ?? null;
  }
  const record = headers as Record<string, string | undefined>;
  // Node 的入站 header 名一律小写（Express/Fastify 原样传给我们）：先直接命中，
  // 省掉每个事件 ~13 次 header 读取的 Object.keys() + 逐 key toLowerCase() 分配。
  // 手写对象或混合大小写仍走下面的不区分大小写扫描。
  const direct = record[name];
  if (typeof direct === "string") return direct;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  return key ? (record[key] ?? null) : null;
};

/**
 * 现代浏览器的文档导航（引擎中立）：`Sec-Fetch-*` 只有浏览器会发，
 * 且 **不能要求 `sec-ch-ua`** —— 那是 Chromium 专属 client hints，Firefox/Safari
 * 都不发；要求它等于只跳过 Chromium，人工导航会照样上报并吃掉爬虫预算。
 * `accept` 必须含 text/html，避免把抓 `*​/*` 的机器人判成导航。
 */
const isBrowserNavigation = (headers: HeadersInit | undefined): boolean => {
  if (readHeader(headers, "sec-fetch-mode")?.toLowerCase() !== "navigate") return false;
  if (readHeader(headers, "sec-fetch-dest")?.toLowerCase() !== "document") return false;
  return (readHeader(headers, "accept") ?? "").toLowerCase().includes("text/html");
};

/** 首跳 IP：`cf-connecting-ip` 恒可信；其余代理头仅在 trustProxy 时读。 */
const firstHopIp = (headers: HeadersInit | undefined, trustProxy: boolean): string | null => {
  const direct = readHeader(headers, "cf-connecting-ip")?.trim();
  if (direct) return direct;
  if (!trustProxy) return null;
  const forwarded = readHeader(headers, "x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  for (const name of ["x-real-ip", "true-client-ip", "fly-client-ip"]) {
    const value = readHeader(headers, name)?.trim();
    if (value) return value;
  }
  return null;
};

/** IP 只做长度/空白护栏：服务端 `ip.max(45)`，超长会让整条事件 400。 */
const sanitizeIp = (raw: string | null | undefined): string | undefined => {
  const value = (raw ?? "").trim();
  if (!value || value.length > MAX_IP_LENGTH || /\s/.test(value)) return undefined;
  return value;
};

/**
 * Host 大小写不敏感，但 Web Bot Auth 的 `@authority` 用原始值验签：
 * 只去空白，不归一大小写（URL 回退路径本身会被 `URL` 解析成小写）。
 */
const sanitizeHost = (raw: string | null | undefined): string | undefined => {
  const value = (raw ?? "").trim();
  if (!value || value.length > MAX_HOST_LENGTH || /\s/.test(value)) return undefined;
  return value;
};

/** 三个签名头齐全、非空且都在服务端上限内才可上报；半套头验不了签，报也无用。 */
const sanitizeWebBotAuth = (
  candidate: WebBotAuthHeaders | null | undefined,
): WebBotAuthHeaders | undefined => {
  if (!candidate) return undefined;
  const signatureAgent = candidate.signatureAgent.trim();
  const signatureInput = candidate.signatureInput.trim();
  const signature = candidate.signature.trim();
  if (!signatureAgent || signatureAgent.length > MAX_SIGNATURE_AGENT_LENGTH) return undefined;
  if (!signatureInput || signatureInput.length > MAX_SIGNATURE_INPUT_LENGTH) return undefined;
  if (!signature || signature.length > MAX_SIGNATURE_LENGTH) return undefined;
  return { signatureAgent, signatureInput, signature };
};

/**
 * 读取入站 Web Bot Auth 头（RFC 9421；header 名大小写不敏感）。
 * `Signature-Agent` 不存在 = 未签名（不是伪造），直接 undefined；
 * 但只带一部分头时同样丢弃——三缺一服务端无法验签，不值得让载荷更大。
 */
export const webBotAuthOf = (headers: HeadersInit | undefined): WebBotAuthHeaders | undefined => {
  const signatureAgent = readHeader(headers, "signature-agent");
  if (signatureAgent === null) return undefined;
  return sanitizeWebBotAuth({
    signatureAgent,
    signatureInput: readHeader(headers, "signature-input") ?? "",
    signature: readHeader(headers, "signature") ?? "",
  });
};

/** 原始 `host` 头优先（验签要原文）；缺失或非法时回退到请求 URL 的 authority。 */
export const authorityOf = (
  headers: HeadersInit | undefined,
  url: string | null | undefined,
  trustProxy = false,
): string | undefined => {
  // 反向代理之后 `host` 常是内部上游主机，公开 Host 只在 `x-forwarded-host`。
  // 与 IP 同一信任口径：只有站点声明自己在代理后面时才信这个头。
  if (trustProxy) {
    const forwarded = sanitizeHost(readHeader(headers, "x-forwarded-host")?.split(",")[0]);
    if (forwarded !== undefined) return forwarded;
  }
  const fromHeader = sanitizeHost(readHeader(headers, "host"));
  if (fromHeader !== undefined) return fromHeader;
  if (!url) return undefined;
  try {
    return sanitizeHost(new URL(url).host);
  } catch {
    return undefined;
  }
};

const pathOf = (request: Request): string => {
  try {
    return new URL(request.url).pathname || "/";
  } catch {
    return "/";
  }
};

/**
 * 采集端自己的写入路径。探针与采集器同源时（自托管、或把 `/v1/probe` 反代回同一个
 * 应用），`send()` 的 POST 会再进一次被包裹的 handler，而它不是浏览器导航——不跳过
 * 就会自我递归上报，直到把子请求打满。默认跳过这三点；自定义挂载点在包裹层自行排除。
 */
const OWN_INGEST_PATHS = new Set(["/v1/probe", "/v1/probe/batch", "/v1/probe/check"]);

/** 跳过判断只看 pathname：query/hash 与尾斜杠都不该让同一端点漏过去。 */
const isOwnIngestPath = (raw: string | null | undefined): boolean => {
  const pathname = (raw ?? "/").split("?")[0]?.split("#")[0] ?? "/";
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return OWN_INGEST_PATHS.has(normalized);
};

const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** `utm_source` → 域名 token（小写、去 scheme/path/port/www、≤64）。 */
export const normalizeUtmSource = (raw: string | null | undefined): string | undefined => {
  if (!raw) return undefined;
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .slice(0, MAX_UTM_LENGTH);
  return value.length > 0 ? value : undefined;
};

const utmOf = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return normalizeUtmSource(new URL(url, "http://localhost").searchParams.get("utm_source"));
  } catch {
    return undefined;
  }
};

/**
 * Netlify 的 `x-nf-geo` 是 base64 JSON（`{"country":{"code":"US"},…}`）。
 * 解不出来就当没有：地理只是增强字段，不值得为它引依赖或抛错。
 */
const netlifyCountry = (headers: HeadersInit | undefined): string | null => {
  const raw = readHeader(headers, "x-nf-geo")?.trim();
  if (!raw) return null;
  const atobFn = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof atobFn !== "function") return null;
  try {
    const json = JSON.parse(atobFn(raw.replace(/-/g, "+").replace(/_/g, "/"))) as {
      country?: { code?: unknown } | string;
    };
    const code = typeof json.country === "string" ? json.country : json.country?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
};

const countryOf = (
  headers: HeadersInit | undefined,
  input: ProbeInput,
  fallback: string | undefined,
): string | undefined => {
  const candidates = [
    input.country ?? undefined,
    readHeader(headers, "cf-ipcountry") ?? undefined,
    readHeader(headers, "x-vercel-ip-country") ?? undefined,
    netlifyCountry(headers) ?? undefined,
    fallback,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") return value;
  }
  return undefined;
};

const coloOf = (
  headers: HeadersInit | undefined,
  input: ProbeInput,
  fallback: string | undefined,
): string | undefined => {
  const ray = readHeader(headers, "cf-ray")?.trim() ?? "";
  const fromRay = /-([A-Za-z]{3})$/.exec(ray)?.[1];
  for (const candidate of [input.colo ?? undefined, fromRay, fallback]) {
    if (!candidate) continue;
    const value = candidate.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(value)) return value;
  }
  return undefined;
};

const negOf = (response: Response): "html" | "markdown" =>
  (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/markdown")
    ? "markdown"
    : "html";

/** `AbortSignal.timeout` 缺失时退回不设限：宁可不超时，也不要整包静默失效。 */
const timeoutSignal = (ms: number): AbortSignal | undefined => {
  const create = (AbortSignal as unknown as { timeout?: (value: number) => AbortSignal }).timeout;
  return typeof create === "function" ? create(ms) : undefined;
};

/** 批量配置夹紧：越界不是报错而是明确降级 + 一条 warning（否则整批 400 且无提示）。 */
const resolveBatch = (
  batch: BatchConfig | undefined,
): { maxEvents: number; flushMs: number } | null => {
  if (!batch || batch.maxEvents <= 1 || batch.flushMs <= 0) return null;
  const maxEvents = Math.min(Math.floor(batch.maxEvents), MAX_BATCH_EVENTS);
  const flushMs = Math.min(Math.floor(batch.flushMs), MAX_FLUSH_MS);
  if (maxEvents !== batch.maxEvents || flushMs !== batch.flushMs) {
    console.warn(
      `[agent-watch] batch clamped to maxEvents<=${MAX_BATCH_EVENTS}, flushMs<=${MAX_FLUSH_MS}`,
    );
  }
  return { maxEvents, flushMs };
};

/** 批量拆包：先按 50 条封顶，再按 32 KB 封顶（长 ref/path 会把 50 条顶到 100 KB）。 */
const splitBatch = (site: string, events: BufferedEvent[]): BufferedEvent[][] => {
  const chunks: BufferedEvent[][] = [];
  // 线性累加而不是每加一条就 stringify 整个候选数组：50 条时后者会生成 ~1.2k 次
  // 最长 32 KB 的临时字符串，在 Workers 上纯属烧 CPU。
  const envelope = encoder.encode(JSON.stringify({ site, events: [] })).length;
  const budget = MAX_BATCH_BODY_BYTES - 64;
  let current: BufferedEvent[] = [];
  let bytes = envelope;
  for (const event of events) {
    const size = event.bytes + 1;
    if (current.length > 0 && (current.length >= MAX_BATCH_EVENTS || bytes + size > budget)) {
      chunks.push(current);
      current = [];
      bytes = envelope;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

/** 批量请求体：事件已按条序列化，这里只拼装，避免整批再 JSON.stringify 一遍。 */
const batchBody = (site: string, events: BufferedEvent[]): string =>
  `{"site":${JSON.stringify(site)},"events":[${events.map((event) => event.body).join(",")}]}`;

export const createAgentWatch = (config: AgentWatchConfig): AgentWatch => {
  const token = config.token?.trim();
  if (!token) {
    // 唯一允许抛错的位置：这是接错线，不是运行时噪声。
    throw new Error("[agent-watch] createAgentWatch({ token }) requires a site token");
  }
  const endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
  const sendIp = config.sendIp !== false;
  const skipBrowserNavigations = config.skipBrowserNavigations !== false;
  const trustProxy = config.trustProxy === true;
  // 0 会让每次上报立刻 abort（外部症状同样是「永远没数据」），下限收到 50ms。
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? REPORT_TIMEOUT_MS, 50), 30_000);
  const fetchImpl = config.fetch ?? fetch;
  const batch = resolveBatch(config.batch);
  const debug = config.debug === true;
  let warned = false;

  /** 失败永远不外抛：`onError` 只做观测，`debug` 只 warn 一次。 */
  const reportFailure = (failure: ProbeFailure): void => {
    if (config.onError) {
      try {
        config.onError(failure);
      } catch {
        // 观测回调不能反过来打断上报。
      }
      return;
    }
    if (!debug || warned) return;
    warned = true;
    const detail = failure.status === undefined ? "network error" : `HTTP ${failure.status}`;
    console.warn(
      `[agent-watch] report to ${failure.path} failed (${detail}); call watch.check() to verify the site token. Further failures are silent.`,
    );
  };

  const send = async (path: ProbeFailure["path"], body: string, events?: number): Promise<void> => {
    const signal = timeoutSignal(timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-watch": VERSION },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        reportFailure({
          path,
          status: response.status,
          ...(events === undefined ? {} : { events }),
        });
      }
    } catch (error) {
      // 可丢弃信号：网络失败、超时、4xx/5xx、响应解析失败都不向外抛。
      reportFailure({ path, error, ...(events === undefined ? {} : { events }) });
    }
  };

  let buffer: BufferedEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let waitUntilRegistered = false;
  /** waitUntil 的完成回调：批量真正发完（或确认无事件）后再放行，避免请求提前结束。 */
  let finishWaitUntil: (() => void) | null = null;
  /** 串行化 flush：并发 flush 不能提前放行在飞批次的 waitUntil。 */
  let drain: Promise<void> | null = null;

  const clearFlushTimer = (): void => {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const releaseWaitUntil = (): void => {
    const done = finishWaitUntil;
    finishWaitUntil = null;
    waitUntilRegistered = false;
    done?.();
  };

  const flush = (): Promise<void> => {
    clearFlushTimer();
    if (drain) return drain;
    drain = (async () => {
      try {
        // 一次 drain 把缓冲清空；期间新到的事件属于同一轮，不另起一批。
        while (buffer.length > 0) {
          const events = buffer;
          buffer = [];
          for (const chunk of splitBatch(token, events)) {
            await send("/v1/probe/batch", batchBody(token, chunk), chunk.length);
          }
        }
      } finally {
        drain = null;
        if (buffer.length === 0) releaseWaitUntil();
      }
    })();
    return drain;
  };

  const registerWaitUntil = (waitUntil: WaitUntil | undefined): void => {
    if (!waitUntil || waitUntilRegistered) return;
    waitUntilRegistered = true;
    let guard: ReturnType<typeof setTimeout> | null = null;
    try {
      waitUntil(
        new Promise<void>((resolve) => {
          finishWaitUntil = () => {
            if (guard !== null) clearTimeout(guard);
            resolve();
          };
        }),
      );
      // 兜底：flush 定时器在 Worker 里不保证跑；到点直接冲一次，再由 drain 放行。
      guard = setTimeout(
        () => {
          void flush();
        },
        (batch?.flushMs ?? 0) + 2_000,
      );
      (guard as { unref?: () => void }).unref?.();
    } catch {
      // 有的运行时在请求结束后调用 waitUntil 会抛：退回纯 fire-and-forget。
      waitUntilRegistered = false;
      finishWaitUntil = null;
    }
  };

  const enqueue = (payload: ProbePayload, waitUntil: WaitUntil | undefined): void => {
    if (!batch) {
      const task = send("/v1/probe", JSON.stringify(payload));
      if (waitUntil) {
        try {
          waitUntil(task);
          return;
        } catch {
          // waitUntil 抛错时退回不 await 的 fire-and-forget 路径。
        }
      }
      void task;
      return;
    }
    const body = JSON.stringify(payload);
    buffer.push({ body, bytes: encoder.encode(body).length });
    // 先挂 waitUntil 再由 maxEvents 决定是否立刻发：反过来会让「填满即发」的那批
    // 没有任何 waitUntil 覆盖，isolate 结束时整批消失。
    registerWaitUntil(waitUntil);
    if (buffer.length >= batch.maxEvents) {
      void flush();
      return;
    }
    // Workers 下定时器在请求结束后不保证运行：有 waitUntil 就挂住到批量真正发完。
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, batch.flushMs);
      (flushTimer as { unref?: () => void }).unref?.();
    }
  };

  const probe = (input: ProbeInput): void => {
    const ua = (input.ua ?? "").trim().slice(0, MAX_UA_LENGTH);
    if (!ua) return;
    // 同源自托管的自循环：自己的上报请求不能再被上报（见 OWN_INGEST_PATHS）。
    if (isOwnIngestPath(input.path)) return;

    const rawRef = (readHeader(input.headers, "referer") ?? "").trim();
    const ref = rawRef.length > 0 ? rawRef.slice(0, MAX_REF_LENGTH) : undefined;
    // #2：有 Referer 时 utm 只是兜底，不再解析；无 Referer 才取 utm_source。
    const utm = ref === undefined ? utmOf(input.url) : undefined;
    const aiReferral = isAiReferrerHost(hostOf(ref)) || isAiReferrerHost(utm);
    // #3：引荐发生的正是主动导航；命中 AI 引荐域名的导航不得跳过。
    if (skipBrowserNavigations && isBrowserNavigation(input.headers) && !aiReferral) return;

    const payload: ProbePayload = {
      v: 2,
      site: token,
      ua,
      // 服务端 schema 是 max(512) 而不是截断；不 slice 会让长路径整条 400。
      path: (input.path ?? "/").trim().slice(0, MAX_PATH_LENGTH) || "/",
    };
    if (
      typeof input.status === "number" &&
      Number.isInteger(input.status) &&
      input.status >= 100 &&
      input.status <= 599
    ) {
      payload.status = input.status;
    }
    if (sendIp) {
      const ip = sanitizeIp(input.ip) ?? sanitizeIp(firstHopIp(input.headers, trustProxy));
      if (ip) payload.ip = ip;
    }
    if (ref !== undefined) payload.ref = ref;
    if (utm !== undefined) payload.utm = utm;
    if (input.neg !== undefined) payload.neg = input.neg;
    if (
      typeof input.dur === "number" &&
      Number.isInteger(input.dur) &&
      input.dur >= 0 &&
      input.dur <= MAX_DURATION_MS
    ) {
      payload.dur = input.dur;
    }
    const country = countryOf(input.headers, input, config.country);
    if (country !== undefined) payload.country = country;
    const colo = coloOf(input.headers, input, config.colo);
    if (colo !== undefined) payload.colo = colo;
    // 未签名是绝大多数请求：只有真带 `Signature-Agent` 才附 host + 三个签名头。
    // 显式传 `webBotAuth`（含 null）优先于请求头，便于适配器按运行时能力覆盖。
    const webBotAuth =
      input.webBotAuth === undefined
        ? webBotAuthOf(input.headers)
        : sanitizeWebBotAuth(input.webBotAuth);
    if (webBotAuth !== undefined) {
      payload.webBotAuth = webBotAuth;
      const host =
        input.host === undefined
          ? authorityOf(input.headers, input.url, trustProxy)
          : sanitizeHost(input.host);
      if (host !== undefined) payload.host = host;
    }

    enqueue(payload, input.waitUntil);
  };

  const fromRequest = (
    request: Request,
    options?: {
      status?: number;
      neg?: "html" | "markdown";
      dur?: number;
      waitUntil?: WaitUntil;
    },
  ): void => {
    probe({
      ua: request.headers.get("user-agent"),
      path: pathOf(request),
      url: request.url,
      status: options?.status,
      ...(options?.neg === undefined ? {} : { neg: options.neg }),
      ...(options?.dur === undefined ? {} : { dur: options.dur }),
      headers: request.headers,
      ...(options?.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    });
  };

  const wrapFetch = <H extends FetchHandler>(handler: H): H => {
    const wrapped = async (request: Request, ...args: never[]): Promise<Response> => {
      const started = nowMs();
      const context = args[1] as { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
      const waitUntil = context?.waitUntil ? context.waitUntil.bind(context) : undefined;
      let response: Response;
      try {
        response = await handler(request, ...args);
      } catch (error) {
        fromRequest(request, {
          status: 500,
          dur: Math.round(nowMs() - started),
          ...(waitUntil === undefined ? {} : { waitUntil }),
        });
        throw error;
      }
      fromRequest(request, {
        status: response.status,
        neg: negOf(response),
        dur: Math.round(nowMs() - started),
        ...(waitUntil === undefined ? {} : { waitUntil }),
      });
      return response;
    };
    return wrapped as H;
  };

  const check = async (): Promise<ProbeCheckResult> => {
    const signal = timeoutSignal(timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/v1/probe/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-watch": VERSION },
        body: JSON.stringify({ site: token }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status === 404) return { valid: false, reason: "invalid" };
      if (!response.ok) return { valid: false, reason: "unreachable" };
      const body = (await response.json()) as { data?: { valid?: unknown } };
      return body.data?.valid === true ? { valid: true } : { valid: false, reason: "unreachable" };
    } catch {
      return { valid: false, reason: "unreachable" };
    }
  };

  const verify = async (): Promise<boolean> => (await check()).valid;

  return {
    probe,
    fromRequest,
    wrapFetch,
    flush,
    check,
    verify,
  };
};
