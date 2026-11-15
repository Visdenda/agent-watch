import { describe, expect, it } from "vitest";

import { createAgentWatch } from "@visdenda/agent-watch";

/** 探针核心行为（crawler-directory T-k / EARS #15–#21）。 */

type Call = { url: string; init: RequestInit | undefined };

const fakeFetch = (calls: Call[], status = 204): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  }) as typeof fetch;

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

describe("agent-watch probe", () => {
  it("posts one payload to /v1/probe with a trimmed endpoint", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      endpoint: "https://collector.example/",
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot/1.2", path: "/pricing", status: 200, ip: "203.0.113.7" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://collector.example/v1/probe");
    expect(bodyOf(calls[0])).toEqual({
      v: 2,
      site: "vdc_test",
      ua: "GPTBot/1.2",
      path: "/pricing",
      status: 200,
      ip: "203.0.113.7",
    });
  });

  it("trusts x-forwarded-for only when trustProxy is enabled", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });
    const proxied = createAgentWatch({
      token: "vdc_test",
      trustProxy: true,
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    expect(bodyOf(calls[0])?.ip).toBeUndefined();

    watch.probe({ ua: "GPTBot", headers: { "cf-connecting-ip": "198.51.100.4" } });
    expect(bodyOf(calls[1])?.ip).toBe("198.51.100.4");

    proxied.probe({ ua: "GPTBot", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    expect(bodyOf(calls[2])?.ip).toBe("203.0.113.9");
  });

  it("reads plain-object headers case-insensitively (mixed-case keys)", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    // Express/Fastify 给的是普通对象；Node 的 key 是小写，但手写对象可能混大小写，
    // 快路径未命中时必须仍回退到不区分大小写的扫描。
    watch.probe({
      ua: "GPTBot",
      headers: { "CF-Connecting-IP": "198.51.100.4", Referer: "https://chatgpt.com/x" },
    });
    expect(bodyOf(calls[0])?.ip).toBe("198.51.100.4");
    expect(bodyOf(calls[0])?.ref).toBe("https://chatgpt.com/x");
  });

  it("omits the IP when sendIp is false", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", sendIp: false, fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      ip: "203.0.113.7",
      headers: { "cf-connecting-ip": "203.0.113.8" },
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("ip");
  });

  it("skips browser document navigations without Chromium-only client hints", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    // Firefox / Safari 同样发 Sec-Fetch-*，但不发 sec-ch-ua：只认 client hints
    // 等于只跳过 Chromium，人工导航会照常上报并吃掉爬虫预算。
    watch.probe({
      ua: "Mozilla/5.0",
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        accept: "text/html,application/xhtml+xml",
      },
    });
    expect(calls).toHaveLength(0);

    // 抓 `*/*` 的机器人伪造 mode/dest 也不会被当成导航。
    watch.probe({
      ua: "GPTBot",
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "*/*" },
    });
    expect(calls).toHaveLength(1);

    // 只发 mode、没有 dest 的旧客户端照常上报（宁可多报，不可漏爬虫）。
    watch.probe({
      ua: "Mozilla/5.0",
      headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    expect(calls).toHaveLength(2);
  });

  it("keeps events inside the server schema: truncates path and drops unstoreable IPs", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    // 服务端 schema 是 path.max(512)：不截断就是整条 400，而 SDK 把 400 吞掉了。
    watch.probe({ ua: "GPTBot", path: `/${"p".repeat(2_000)}` });
    expect(String(bodyOf(calls[0])?.path)).toHaveLength(512);

    watch.probe({ ua: "GPTBot", ip: "1".repeat(46) });
    expect(bodyOf(calls[1])).not.toHaveProperty("ip");

    watch.probe({ ua: "GPTBot", ip: "  " });
    expect(bodyOf(calls[2])).not.toHaveProperty("ip");
  });

  it("reads reverse-proxy platform headers only when trustProxy is on", () => {
    const calls: Call[] = [];
    const proxied = createAgentWatch({
      token: "vdc_test",
      trustProxy: true,
      fetch: fakeFetch(calls),
    });

    proxied.probe({ ua: "GPTBot", headers: { "x-real-ip": "198.51.100.7" } });
    expect(bodyOf(calls[0])?.ip).toBe("198.51.100.7");

    proxied.probe({ ua: "GPTBot", headers: { "fly-client-ip": "198.51.100.8" } });
    expect(bodyOf(calls[1])?.ip).toBe("198.51.100.8");

    // 未开启 trustProxy 时这些头一律不读：任意客户端都能伪造。
    const untrusted = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });
    untrusted.probe({ ua: "GPTBot", headers: { "x-real-ip": "198.51.100.9" } });
    expect(bodyOf(calls[2])).not.toHaveProperty("ip");
  });

  it("drops empty UA and truncates over-long UA instead of dropping it", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "" });
    expect(calls).toHaveLength(0);

    watch.probe({ ua: "G".repeat(513) });
    watch.probe({ ua: "G".repeat(512) });
    expect(calls).toHaveLength(2);
    expect(String(bodyOf(calls[0])?.ua)).toHaveLength(512);
    expect(String(bodyOf(calls[1])?.ua)).toHaveLength(512);
  });

  it("hands the report to waitUntil when the runtime provides one", async () => {
    const calls: Call[] = [];
    const tasks: Array<Promise<unknown>> = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "GPTBot", waitUntil: (task) => tasks.push(task) });

    expect(tasks).toHaveLength(1);
    await tasks[0];
    expect(calls).toHaveLength(1);
  });

  it("swallows fetch failures without an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const watch = createAgentWatch({
        token: "vdc_test",
        fetch: (async () => {
          throw new Error("collector down");
        }) as typeof fetch,
      });
      expect(() => watch.probe({ ua: "GPTBot" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(rejections).toHaveLength(0);
  });

  it("requires a site token at init", () => {
    expect(() => createAgentWatch({ token: "   " })).toThrow(/site token/);
  });

  it("reads UA, path and IP from a fetch Request", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      trustProxy: true,
      fetch: fakeFetch(calls),
    });

    watch.fromRequest(
      new Request("https://example.com/a/b?q=1", {
        headers: { "user-agent": "ClaudeBot/1.0", "x-forwarded-for": "203.0.113.5" },
      }),
    );

    expect(bodyOf(calls[0])).toMatchObject({
      ua: "ClaudeBot/1.0",
      path: "/a/b",
      ip: "203.0.113.5",
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("status");
  });
});
