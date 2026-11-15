import { describe, expect, it } from "vitest";

import { contextMiddleware } from "@visdenda/agent-watch/hono";
import { nodeMiddleware } from "@visdenda/agent-watch/node";
import { requestMiddleware } from "@visdenda/agent-watch/next";
import { wrapFetch } from "@visdenda/agent-watch/workers";

/** 适配器（crawler-directory T-j / EARS #16–#18）：都发一次 POST，status 按能力取舍。 */

type Call = { url: string; init: RequestInit | undefined };

const fakeFetch = (calls: Call[]): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

const request = (userAgent = "GPTBot/1.2"): Request =>
  new Request("https://example.com/pricing?ref=1", {
    headers: { "user-agent": userAgent, "cf-connecting-ip": "203.0.113.7" },
  });

describe("agent-watch adapters", () => {
  it("requestMiddleware reports the request without a status", () => {
    const calls: Call[] = [];
    const probe = requestMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });

    expect(probe(request())).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({
      v: 2,
      site: "vdc_test",
      ua: "GPTBot/1.2",
      path: "/pricing",
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("status");
  });

  it("contextMiddleware reports the status after next()", async () => {
    const calls: Call[] = [];
    const middleware = contextMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });
    let proceeded = false;

    await middleware(
      { req: { raw: request() }, res: new Response("teapot", { status: 418 }) },
      async () => {
        proceeded = true;
      },
    );

    expect(proceeded).toBe(true);
    expect(bodyOf(calls[0])).toMatchObject({ ua: "GPTBot/1.2", status: 418 });
  });

  it("nodeMiddleware reports the status on finish", () => {
    const calls: Call[] = [];
    const middleware = nodeMiddleware({
      token: "vdc_test",
      trustProxy: true,
      fetch: fakeFetch(calls),
    });
    let finish: (() => void) | undefined;

    middleware(
      {
        headers: { "user-agent": "PerplexityBot/1.0", "x-forwarded-for": "198.51.100.2" },
        originalUrl: "/docs?x=1",
      },
      {
        statusCode: 503,
        on: (_event, listener) => {
          finish = listener;
        },
      },
      () => {},
    );

    // 放行之后才上报：finish 前的 200 不能把 5xx 记错。
    expect(calls).toHaveLength(0);
    finish?.();

    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({
      ua: "PerplexityBot/1.0",
      // originalUrl 的 query 不进 path：服务端 schema 先按 max(512) 校验，
      // 长 query 会让整条事件 400，而 SDK 把 400 吞掉了。
      path: "/docs",
      status: 503,
      ip: "198.51.100.2",
    });
  });

  it("requestMiddleware hands the report to waitUntil when given one", async () => {
    const calls: Call[] = [];
    const tasks: Array<Promise<unknown>> = [];
    const probe = requestMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });

    probe(request(), (task) => tasks.push(task));

    expect(tasks).toHaveLength(1);
    await tasks[0];
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({ ua: "GPTBot/1.2", path: "/pricing" });
  });

  it("contextMiddleware reports 500 and rethrows when next() throws", async () => {
    const calls: Call[] = [];
    const middleware = contextMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });

    await expect(
      middleware({ req: { raw: request() } }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(bodyOf(calls[0])).toMatchObject({ status: 500 });
  });

  it("wrapFetch reports the real status through ctx.waitUntil", async () => {
    const calls: Call[] = [];
    const tasks: Array<Promise<unknown>> = [];
    const handler = wrapFetch(
      { token: "vdc_test", fetch: fakeFetch(calls) },
      async (
        _request: Request,
        _env: unknown,
        _ctx: { waitUntil?: (promise: Promise<unknown>) => void },
      ) => new Response("missing", { status: 404 }),
    );

    const response = await handler(request(), {}, { waitUntil: (task) => tasks.push(task) });

    expect(response.status).toBe(404);
    expect(tasks).toHaveLength(1);
    await tasks[0];
    expect(bodyOf(calls[0])).toMatchObject({ status: 404 });
  });

  it("wrapFetch works without a ctx (Bun / Deno shape) and still reports", async () => {
    const calls: Call[] = [];
    const handler = wrapFetch(
      { token: "vdc_test", fetch: fakeFetch(calls) },
      async (_request: Request) => new Response("ok", { status: 200 }),
    );

    await handler(request());
    expect(bodyOf(calls[0])).toMatchObject({ status: 200 });
  });
});
