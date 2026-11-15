import { createAgentWatch, type AgentWatchConfig } from "../probe";
import { nowMs } from "../timing";

type ContextLike = {
  req: { raw: Request };
  res?: Response;
  executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void };
};

type NextFn = () => Promise<void>;

/**
 * 上下文 + `next()` 形态的中间件（response-aware，Hono 是典型）：`await next()` 之后带真实
 * status 上报。`next()` 抛错时先报一次 500 再原样抛出 —— 未捕获异常恰恰是爬虫命中坏路径的形态。
 */
export const contextMiddleware = (config: AgentWatchConfig) => {
  const watch = createAgentWatch(config);
  return async (context: ContextLike, next: NextFn): Promise<void> => {
    const started = nowMs();

    // executionCtx 在非 Workers 运行时是 getter，访问即抛错。
    let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
    try {
      const ctx = context.executionCtx;
      waitUntil = ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : undefined;
    } catch {
      waitUntil = undefined;
    }
    const report = (status: number | undefined, neg: "html" | "markdown" | undefined): void =>
      watch.fromRequest(context.req.raw, {
        status,
        dur: Math.round(nowMs() - started),
        ...(neg === undefined ? {} : { neg }),
        ...(waitUntil === undefined ? {} : { waitUntil }),
      });

    try {
      await next();
    } catch (error) {
      report(500, undefined);
      throw error;
    }

    let status: number | undefined;
    let neg: "html" | "markdown" | undefined;
    try {
      status = context.res?.status;
      const contentType = context.res?.headers.get("content-type") ?? "";
      if (contentType.length > 0) {
        neg = contentType.toLowerCase().startsWith("text/markdown") ? "markdown" : "html";
      }
    } catch {
      status = undefined;
      neg = undefined;
    }
    report(status, neg);
  };
};
