import { createAgentWatch, type AgentWatchConfig } from "../probe";
import { nowMs } from "../timing";

type ExpressRequest = {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
};

type ExpressResponse = {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
};

type ExpressNext = () => void;

/** `originalUrl` 带 query：服务端会再归一，但 schema 先按 max(512) 校验，长 query 会整条 400。 */
const pathOf = (raw: string | undefined): string => {
  if (!raw) return "/";
  try {
    return new URL(raw, "http://localhost").pathname || "/";
  } catch {
    return raw;
  }
};

/**
 * Node `(req, res, next)` 中间件（response-aware，Express/Koa/Polka/Nest 同形）：
 * 先挂 `finish` 再放行，`finish` 后带真实 status 上报。
 * 只在 `finish` 触发 —— 提前上报会把 5xx 记成 200；而监听器必须在 `next()` 之前注册，
 * 否则同步 `res.end()` 的处理器可能在注册之前就把事件发完。
 * IP 交给 probe 统一解析（`trustProxy` 决定是否信 x-forwarded-for）。
 */
export const nodeMiddleware = (config: AgentWatchConfig) => {
  const watch = createAgentWatch(config);
  return (request: ExpressRequest, response: ExpressResponse, next: ExpressNext): void => {
    const started = nowMs();
    response.on("finish", () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      const url = request.originalUrl ?? request.url ?? null;
      watch.probe({
        ua: headers["user-agent"] ?? null,
        path: pathOf(url ?? undefined),
        url,
        status: response.statusCode,
        dur: Math.round(nowMs() - started),
        headers,
      });
    });
    next();
  };
};
