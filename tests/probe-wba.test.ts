import { describe, expect, it } from "vitest";

import {
  authorityOf,
  createAgentWatch,
  webBotAuthOf,
  type WebBotAuthHeaders,
} from "@visdenda/agent-watch";
import { requestMiddleware } from "@visdenda/agent-watch/next";
import { nodeMiddleware } from "@visdenda/agent-watch/node";
import { wrapFetch } from "@visdenda/agent-watch/workers";

/**
 * Web Bot Auth 探针字段（RFC 9421）：只在请求带 `Signature-Agent` 时附上
 * `host` + 三个签名头；半套头或超限一律不上报，避免验不了签的载荷。
 */

type Call = { url: string; init: RequestInit | undefined };

const fakeFetch = (calls: Call[]): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

const SIGNATURE_AGENT = "https://agent.example/keys/2026";
const SIGNATURE_INPUT = 'sig1=("@authority" "signature-agent");keyid="k1";alg="ed25519"';
const SIGNATURE = "MEUCIQDsignaturebytes+/==";

const webBotAuth = (): WebBotAuthHeaders => ({
  signatureAgent: SIGNATURE_AGENT,
  signatureInput: SIGNATURE_INPUT,
  signature: SIGNATURE,
});

const signedHeaders = (host?: string): Record<string, string> => ({
  ...(host === undefined ? {} : { host }),
  "signature-agent": SIGNATURE_AGENT,
  "signature-input": SIGNATURE_INPUT,
  signature: SIGNATURE,
});

describe("webBotAuthOf / authorityOf helpers", () => {
  it("reads the three headers case-insensitively", () => {
    expect(
      webBotAuthOf({
        "Signature-Agent": SIGNATURE_AGENT,
        "SIGNATURE-INPUT": SIGNATURE_INPUT,
        Signature: SIGNATURE,
      }),
    ).toEqual(webBotAuth());

    expect(
      webBotAuthOf(
        new Headers({
          "Signature-Agent": SIGNATURE_AGENT,
          "Signature-Input": SIGNATURE_INPUT,
          Signature: SIGNATURE,
        }),
      ),
    ).toEqual(webBotAuth());
  });

  it("returns undefined without Signature-Agent, or when any header is missing/empty", () => {
    expect(webBotAuthOf(undefined)).toBeUndefined();
    expect(webBotAuthOf({ host: "example.com" })).toBeUndefined();
    expect(webBotAuthOf({ "signature-agent": SIGNATURE_AGENT })).toBeUndefined();
    expect(
      webBotAuthOf({
        "signature-agent": SIGNATURE_AGENT,
        "signature-input": SIGNATURE_INPUT,
      }),
    ).toBeUndefined();
    expect(
      webBotAuthOf({
        "signature-agent": SIGNATURE_AGENT,
        "signature-input": SIGNATURE_INPUT,
        signature: "   ",
      }),
    ).toBeUndefined();
  });

  it("drops the whole set when any header exceeds the server caps", () => {
    expect(
      webBotAuthOf({ ...signedHeaders(), "signature-agent": "a".repeat(1_025) }),
    ).toBeUndefined();
    expect(
      webBotAuthOf({ ...signedHeaders(), "signature-input": "i".repeat(4_097) }),
    ).toBeUndefined();
    expect(webBotAuthOf({ ...signedHeaders(), signature: "s".repeat(4_097) })).toBeUndefined();

    // 正好在上限内的仍可上报（服务端是 max，不是截断）。
    expect(
      webBotAuthOf({ ...signedHeaders(), "signature-agent": "a".repeat(1_024) }),
    ).toMatchObject({ signatureAgent: "a".repeat(1_024) });
  });

  it("prefers the raw Host header (trimmed, case preserved) and falls back to the URL", () => {
    expect(authorityOf({ Host: "  Example.COM  " }, "https://other.example/x")).toBe("Example.COM");
    expect(authorityOf(undefined, "https://Example.com:8443/x")).toBe("example.com:8443");
    // 非法 Host 不能把整条事件顶成 400：回退到 URL authority。
    expect(authorityOf({ host: "h".repeat(254) }, "https://example.com/x")).toBe("example.com");
    expect(authorityOf({ host: "bad host" }, undefined)).toBeUndefined();
    expect(authorityOf(undefined, "not a url")).toBeUndefined();
  });

  it("uses x-forwarded-host only when trustProxy is on", () => {
    const headers = {
      host: "internal.example",
      "x-forwarded-host": " Public.Example , proxy.internal",
    };
    expect(authorityOf(headers, undefined, true)).toBe("Public.Example");
    expect(authorityOf(headers, undefined)).toBe("internal.example");
    // 信任代理但代理没给 forwarded 时，仍退回原始 host / URL。
    expect(authorityOf({ host: "internal.example" }, undefined, true)).toBe("internal.example");
    expect(authorityOf(undefined, "https://example.com/x", true)).toBe("example.com");
  });
});

describe("probe payload: Web Bot Auth", () => {
  it("adds host and the full header set when the request is signed", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      path: "/pricing",
      url: "https://example.com/pricing",
      headers: {
        Host: "Example.com",
        "Signature-Agent": SIGNATURE_AGENT,
        "Signature-Input": SIGNATURE_INPUT,
        Signature: SIGNATURE,
      },
    });

    expect(bodyOf(calls[0])).toMatchObject({
      ua: "GPTBot",
      path: "/pricing",
      // `@authority` 验签要原文：不去大小写、不补端口。
      host: "Example.com",
      webBotAuth: webBotAuth(),
    });
  });

  it("falls back to the request URL authority when no Host header is exposed", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      url: "https://Example.COM:8443/agents",
      headers: signedHeaders(),
    });

    expect(bodyOf(calls[0])?.host).toBe("example.com:8443");
    expect(bodyOf(calls[0])?.webBotAuth).toEqual(webBotAuth());
  });

  it("trusts x-forwarded-host for the reported authority only with trustProxy", () => {
    const calls: Call[] = [];
    const untrusted = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });
    const trusted = createAgentWatch({
      token: "vdc_test",
      trustProxy: true,
      fetch: fakeFetch(calls),
    });

    // 反向代理后 `host` 是内部上游；关闭 trustProxy 时不能拿客户端可伪造的头替换它。
    untrusted.probe({
      ua: "GPTBot",
      url: "http://internal:3000/agents",
      headers: { ...signedHeaders("internal.example"), "x-forwarded-host": "public.example" },
    });
    expect(bodyOf(calls[0])?.host).toBe("internal.example");

    trusted.probe({
      ua: "GPTBot",
      url: "http://internal:3000/agents",
      headers: {
        ...signedHeaders("internal.example"),
        "x-forwarded-host": " Public.Example , proxy.internal",
      },
    });
    expect(bodyOf(calls[1])?.host).toBe("Public.Example");

    // 没有原始 host 头时 forwarded 仍优先于 URL authority。
    trusted.probe({
      ua: "GPTBot",
      url: "http://internal:3000/agents",
      headers: { ...signedHeaders(), "x-forwarded-host": "public.example" },
    });
    expect(bodyOf(calls[2])?.host).toBe("public.example");
  });

  it("reports nothing extra without signature headers, even if Host is present", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "GPTBot", headers: { host: "example.com" } });
    expect(bodyOf(calls[0])).not.toHaveProperty("host");
    expect(bodyOf(calls[0])).not.toHaveProperty("webBotAuth");
  });

  it("does not report a half header set", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "GPTBot", headers: signedHeaders("example.com") });
    expect(bodyOf(calls[0])).toHaveProperty("webBotAuth");

    // 只有 Signature-Agent = 未签名：host 也一起省略，避免所有事件膨胀。
    watch.probe({
      ua: "GPTBot",
      headers: { host: "example.com", "signature-agent": SIGNATURE_AGENT },
    });
    expect(bodyOf(calls[1])).not.toHaveProperty("webBotAuth");
    expect(bodyOf(calls[1])).not.toHaveProperty("host");
  });

  it("drops over-long signature headers instead of sending a doomed payload", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      headers: { host: "example.com", ...signedHeaders(), signature: "s".repeat(4_097) },
    });

    expect(bodyOf(calls[0])).not.toHaveProperty("webBotAuth");
    expect(bodyOf(calls[0])).not.toHaveProperty("host");
  });

  it("honors explicit host/webBotAuth overrides and null suppression", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      headers: { host: "header.example" },
      host: "  api.example.com  ",
      webBotAuth: webBotAuth(),
    });
    expect(bodyOf(calls[0])).toMatchObject({
      host: "api.example.com",
      webBotAuth: webBotAuth(),
    });

    // 适配器明确说「这个运行时拿不到签名」时，不能再用请求头补一套。
    watch.probe({ ua: "GPTBot", headers: signedHeaders("header.example"), webBotAuth: null });
    expect(bodyOf(calls[1])).not.toHaveProperty("webBotAuth");
    expect(bodyOf(calls[1])).not.toHaveProperty("host");
  });

  it("keeps host/webBotAuth inside batched events", async () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 2, flushMs: 9_000 },
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot", path: "/a", headers: signedHeaders("example.com") });
    watch.probe({ ua: "GPTBot", path: "/b", headers: signedHeaders("example.com") });
    await watch.flush();

    expect(calls).toHaveLength(1);
    const events = (bodyOf(calls[0]) as { events?: Array<Record<string, unknown>> }).events;
    expect(events).toHaveLength(2);
    expect(events?.[0]).toMatchObject({
      path: "/a",
      host: "example.com",
      webBotAuth: webBotAuth(),
    });
    expect(events?.[1]).toMatchObject({
      path: "/b",
      host: "example.com",
      webBotAuth: webBotAuth(),
    });
  });
});

describe("adapters forward Web Bot Auth headers", () => {
  it("nodeMiddleware passes the Host record through", () => {
    const calls: Call[] = [];
    const middleware = nodeMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });
    let finish: (() => void) | undefined;

    middleware(
      {
        headers: {
          host: "Example.com",
          "user-agent": "GPTBot/1.2",
          "signature-agent": SIGNATURE_AGENT,
          "signature-input": SIGNATURE_INPUT,
          signature: SIGNATURE,
        },
        originalUrl: "/docs?x=1",
      },
      {
        statusCode: 200,
        on: (_event, listener) => {
          finish = listener;
        },
      },
      () => {},
    );
    finish?.();

    expect(bodyOf(calls[0])).toMatchObject({
      ua: "GPTBot/1.2",
      path: "/docs",
      host: "Example.com",
      webBotAuth: webBotAuth(),
    });
  });

  it("requestMiddleware reads a fetch Request", () => {
    const calls: Call[] = [];
    const probe = requestMiddleware({ token: "vdc_test", fetch: fakeFetch(calls) });

    probe(
      new Request("https://example.com/agents", {
        headers: { "user-agent": "GPTBot/1.2", ...signedHeaders("example.com") },
      }),
    );

    expect(bodyOf(calls[0])).toMatchObject({ host: "example.com", webBotAuth: webBotAuth() });
  });

  it("wrapFetch uses the Request URL authority and forwards signatures", async () => {
    const calls: Call[] = [];
    const handler = wrapFetch(
      { token: "vdc_test", fetch: fakeFetch(calls) },
      async (_request: Request) => new Response("ok", { status: 200 }),
    );

    await handler(
      new Request("https://Example.com:8443/agents", {
        headers: { "user-agent": "GPTBot/1.2", ...signedHeaders() },
      }),
    );

    expect(bodyOf(calls[0])).toMatchObject({
      status: 200,
      host: "example.com:8443",
      webBotAuth: webBotAuth(),
    });
  });
});
