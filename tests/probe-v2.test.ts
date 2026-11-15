import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentWatch,
  isAiReferrerHost,
  normalizeUtmSource,
  type ProbeFailure,
} from "@visdenda/agent-watch";
import { markdownCacheKey, markdownNegotiation } from "@visdenda/agent-watch/markdown";

type Call = { url: string; init: RequestInit | undefined };

const fakeFetch = (calls: Call[], status = 204): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  }) as typeof fetch;

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body)) as Record<string, unknown>;

const headerOf = (call: Call | undefined, name: string): string | undefined =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

const navigationHeaders = (referer?: string): Record<string, string> => ({
  "user-agent": "Mozilla/5.0 (Macintosh)",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml",
  ...(referer === undefined ? {} : { referer }),
});

describe("probe v2 client payload (spec probe-v2 #1-#14)", () => {
  it("reports status, dur and neg from wrapFetch", async () => {
    const calls: Call[] = [];
    const handler = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) }).wrapFetch(
      async (_request: Request) =>
        new Response("# doc", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );

    await handler(new Request("https://example.com/docs", { headers: { "user-agent": "GPTBot" } }));

    expect(bodyOf(calls[0])).toMatchObject({ status: 200, neg: "markdown" });
    expect(typeof bodyOf(calls[0])?.dur).toBe("number");
    expect(Number(bodyOf(calls[0])?.dur)).toBeGreaterThanOrEqual(0);
  });

  it("takes ref when present and utm_source only as a fallback", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      headers: { referer: "https://chatgpt.com/c/abc" },
      url: "https://example.com/p?utm_source=perplexity.ai",
    });
    expect(bodyOf(calls[0])).toMatchObject({
      ref: "https://chatgpt.com/c/abc",
    });
    expect(bodyOf(calls[0])).not.toHaveProperty("utm");

    watch.probe({ ua: "GPTBot", url: "https://example.com/p?utm_source=ChatGPT.com" });
    expect(bodyOf(calls[1])).toMatchObject({ utm: "chatgpt.com" });
  });

  it("does not skip browser navigations that carry an AI referrer", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "Mozilla/5.0", headers: navigationHeaders("https://chatgpt.com/c/1") });
    expect(calls).toHaveLength(1);

    watch.probe({ ua: "Mozilla/5.0", headers: navigationHeaders("https://example.com/post") });
    expect(calls).toHaveLength(1);
  });

  it("prefers per-call country/colo over headers and config", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      country: "CA",
      colo: "YYZ",
      fetch: fakeFetch(calls),
    });

    watch.probe({
      ua: "GPTBot",
      headers: { "cf-ipcountry": "de", "cf-ray": "8f3abc123-SJC" },
    });
    expect(bodyOf(calls[0])).toMatchObject({ country: "DE", colo: "SJC" });

    watch.probe({
      ua: "GPTBot",
      country: "FR",
      colo: "AMS",
      headers: { "cf-ipcountry": "DE", "cf-ray": "8f3abc123-SJC" },
    });
    expect(bodyOf(calls[1])).toMatchObject({ country: "FR", colo: "AMS" });

    watch.probe({ ua: "GPTBot" });
    expect(bodyOf(calls[2])).toMatchObject({ country: "CA", colo: "YYZ" });

    // 非法请求头跳到下一个候选（config）；无配置时则不写字段。
    watch.probe({ ua: "GPTBot", headers: { "cf-ipcountry": "XX" } });
    expect(bodyOf(calls[3])).toMatchObject({ country: "CA" });

    const bare = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });
    bare.probe({ ua: "GPTBot", headers: { "cf-ipcountry": "XX" } });
    expect(bodyOf(calls[4])).not.toHaveProperty("country");
  });

  it("truncates ref and drops impossible durations", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({
      ua: "GPTBot",
      headers: { referer: `https://chatgpt.com/${"x".repeat(2_000)}` },
      dur: 600_001,
    });
    expect(String(bodyOf(calls[0])?.ref)).toHaveLength(1_024);
    expect(bodyOf(calls[0])).not.toHaveProperty("dur");
  });

  it("reads platform geo headers (Vercel / Netlify) without throwing on junk", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });

    watch.probe({ ua: "GPTBot", headers: { "x-vercel-ip-country": "gb" } });
    expect(bodyOf(calls[0])?.country).toBe("GB");

    const geo = Buffer.from(JSON.stringify({ country: { code: "DE" } })).toString("base64");
    watch.probe({ ua: "GPTBot", headers: { "x-nf-geo": geo } });
    expect(bodyOf(calls[1])?.country).toBe("DE");

    // 坏 base64 不许抛错，也不许编出一个国家。
    watch.probe({ ua: "GPTBot", headers: { "x-nf-geo": "!!!" } });
    expect(bodyOf(calls[2])).not.toHaveProperty("country");
  });

  it("sends the client version header", () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) });
    watch.probe({ ua: "GPTBot" });
    expect(headerOf(calls[0], "x-agent-watch")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("matches AI referrer hosts by exact domain or subdomain", () => {
    expect(isAiReferrerHost("chatgpt.com")).toBe(true);
    expect(isAiReferrerHost("sub.chatgpt.com")).toBe(true);
    expect(isAiReferrerHost("livechat.com")).toBe(false);
    expect(isAiReferrerHost("chat.com.evil.example")).toBe(false);
    expect(normalizeUtmSource("https://www.ChatGPT.com/x")).toBe("chatgpt.com");
  });
});

describe("probe v2 batching (spec probe-v2 #10-#11)", () => {
  it("flushes as a batch at maxEvents", async () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 2, flushMs: 9_000 },
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot", path: "/a" });
    watch.probe({ ua: "GPTBot", path: "/b" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/probe/batch");
    const body = bodyOf(calls[0]) as { events?: Array<{ path: string }> };
    expect(body.events?.map((event) => event.path)).toEqual(["/a", "/b"]);
    await watch.flush();
  });

  it("flushes the batch on the timer", async () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 10, flushMs: 20 },
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot", path: "/timer" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/probe/batch");
    await watch.flush();
  });

  it("discards a failed batch and keeps accepting new events", async () => {
    const calls: Call[] = [];
    let failures = 1;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (failures > 0) {
        failures -= 1;
        throw new Error("collector down");
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 1 + 1, flushMs: 9_000 },
      fetch: fetchImpl,
    });

    watch.probe({ ua: "GPTBot", path: "/x" });
    watch.probe({ ua: "GPTBot", path: "/y" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    watch.probe({ ua: "GPTBot", path: "/z" });
    watch.probe({ ua: "GPTBot", path: "/w" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.length).toBe(2);
    await watch.flush();
  });
  it("clamps maxEvents to the server limit instead of sending doomed batches", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const calls: Call[] = [];
      const watch = createAgentWatch({
        token: "vdc_test",
        batch: { maxEvents: 200, flushMs: 9_000 },
        fetch: fakeFetch(calls),
      });
      for (let index = 0; index < 51; index += 1) {
        watch.probe({ ua: "GPTBot", path: `/p${index}` });
      }
      await watch.flush();
      expect(warn).toHaveBeenCalled();
      const sizes = calls.map((call) => (bodyOf(call) as { events: unknown[] }).events.length);
      // 服务端 schema 是 max(50)：夹紧后第一批必须正好 50 条，否则整批 400。
      expect(sizes[0]).toBe(50);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(51);
    } finally {
      warn.mockRestore();
    }
  });

  it("splits a batch that would exceed the 32 KB body limit", async () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 50, flushMs: 9_000 },
      fetch: fakeFetch(calls),
    });
    const referer = `https://chatgpt.com/${"x".repeat(1_024)}`;
    for (let index = 0; index < 50; index += 1) {
      watch.probe({ ua: "GPTBot", path: `/p${index}`, headers: { referer } });
    }
    await watch.flush();
    expect(calls.length).toBeGreaterThan(1);
    let total = 0;
    for (const call of calls) {
      total += (bodyOf(call) as { events: unknown[] }).events.length;
      expect(new TextEncoder().encode(String(call.init?.body)).length).toBeLessThanOrEqual(
        32 * 1024,
      );
    }
    expect(total).toBe(50);
  });

  it("splits by UTF-8 bytes, not string length (multibyte referrer)", async () => {
    const calls: Call[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 50, flushMs: 9_000 },
      fetch: fakeFetch(calls),
    });
    // 1024 个中文字符 ≈ 3 KB；50 条约 150 KB，必须按字节拆成多批。
    const referer = `https://chatgpt.com/${"中".repeat(1_024)}`;
    for (let index = 0; index < 50; index += 1) {
      watch.probe({ ua: "GPTBot", path: `/p${index}`, headers: { referer } });
    }
    await watch.flush();
    expect(calls.length).toBeGreaterThan(1);
    let total = 0;
    for (const call of calls) {
      total += (bodyOf(call) as { events: unknown[] }).events.length;
      expect(new TextEncoder().encode(String(call.init?.body)).length).toBeLessThanOrEqual(
        32 * 1024,
      );
    }
    expect(total).toBe(50);
  });

  it("keeps waitUntil pending until a maxEvents-triggered batch is sent", async () => {
    const calls: Call[] = [];
    const tasks: Array<Promise<unknown>> = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 2, flushMs: 9_000 },
      fetch: fakeFetch(calls),
    });

    watch.probe({ ua: "GPTBot", path: "/a", waitUntil: (task) => tasks.push(task) });
    watch.probe({ ua: "GPTBot", path: "/b", waitUntil: (task) => tasks.push(task) });

    expect(tasks).toHaveLength(1);
    await tasks[0];
    expect(calls).toHaveLength(1);
    expect((bodyOf(calls[0]) as { events: unknown[] }).events).toHaveLength(2);
  });

  it("waits for the in-flight batch when flush() is called concurrently", async () => {
    const calls: Call[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      await gate;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 2, flushMs: 9_000 },
      fetch: fetchImpl,
    });

    let released = false;
    watch.probe({
      ua: "GPTBot",
      path: "/a",
      waitUntil: (task) => {
        void task.then(() => {
          released = true;
        });
      },
    });
    watch.probe({ ua: "GPTBot", path: "/b" }); // maxEvents 触发发送，POST 卡在 gate

    // 旧实现里这个并发 flush 看到空缓冲就直接放行 waitUntil；现在必须等 drain。
    const concurrent = watch.flush();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(released).toBe(false);

    (release as (() => void) | null)?.();
    await concurrent;
    expect(released).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("probe v2 self-check and failure reporting", () => {
  it("checks a token and tells invalid from unreachable", async () => {
    const valid = createAgentWatch({
      token: "vdc_test",
      fetch: (async () =>
        new Response(JSON.stringify({ data: { valid: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    expect(await valid.check()).toEqual({ valid: true });
    expect(await valid.verify()).toBe(true);

    const calls: Call[] = [];
    const missing = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls, 404) });
    expect(await missing.check()).toEqual({ valid: false, reason: "invalid" });
    expect(await missing.verify()).toBe(false);
    expect(calls[0]?.url).toBe("https://visdenda.com/v1/probe/check");

    const down = createAgentWatch({
      token: "vdc_test",
      fetch: (async () => {
        throw new Error("collector down");
      }) as typeof fetch,
    });
    expect(await down.check()).toEqual({ valid: false, reason: "unreachable" });
  });

  it("reports a 500 when the wrapped handler throws", async () => {
    const calls: Call[] = [];
    const handler = createAgentWatch({ token: "vdc_test", fetch: fakeFetch(calls) }).wrapFetch(
      async (_request: Request): Promise<Response> => {
        throw new Error("boom");
      },
    );

    await expect(
      handler(new Request("https://example.com/x", { headers: { "user-agent": "GPTBot" } })),
    ).rejects.toThrow("boom");
    expect(bodyOf(calls[0])).toMatchObject({ status: 500, path: "/x" });
  });

  it("reports non-2xx and network failures to onError", async () => {
    const failures: ProbeFailure[] = [];
    const denied = createAgentWatch({
      token: "vdc_test",
      onError: (failure) => failures.push(failure),
      fetch: fakeFetch([], 403),
    });
    denied.probe({ ua: "GPTBot" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures).toEqual([{ path: "/v1/probe", status: 403 }]);

    const down = createAgentWatch({
      token: "vdc_test",
      onError: (failure) => failures.push(failure),
      fetch: (async () => {
        throw new Error("collector down");
      }) as typeof fetch,
    });
    down.probe({ ua: "GPTBot" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures[1]).toMatchObject({ path: "/v1/probe" });
    expect(failures[1]?.error).toBeInstanceOf(Error);
  });

  it("includes the event count when a batch fails", async () => {
    const failures: ProbeFailure[] = [];
    const watch = createAgentWatch({
      token: "vdc_test",
      batch: { maxEvents: 2, flushMs: 9_000 },
      onError: (failure) => failures.push(failure),
      fetch: fakeFetch([], 500),
    });
    watch.probe({ ua: "GPTBot", path: "/a" });
    watch.probe({ ua: "GPTBot", path: "/b" });
    await watch.flush();
    expect(failures).toEqual([{ path: "/v1/probe/batch", status: 500, events: 2 }]);
  });

  it("debug warns once, and onError takes precedence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const debugged = createAgentWatch({
        token: "vdc_test",
        debug: true,
        fetch: fakeFetch([], 500),
      });
      debugged.probe({ ua: "GPTBot" });
      debugged.probe({ ua: "GPTBot" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("watch.check()");

      warn.mockClear();
      const observed = createAgentWatch({
        token: "vdc_test",
        debug: true,
        onError: () => {
          throw new Error("observer boom");
        },
        fetch: fakeFetch([], 500),
      });
      expect(() => observed.probe({ ua: "GPTBot" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("probe v2 markdown cache (spec probe-v2 #13)", () => {
  const PAGE = "https://example.com/docs/page";
  const HTML = "<html><head><title>Doc</title></head><body><h1>Doc</h1></body></html>";
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches?: unknown }).caches = originalCaches;
    }
  });

  const installCache = () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      put: async (request: Request, response: Response) => {
        store.set(request.url, response.clone());
      },
    };
    (globalThis as { caches?: unknown }).caches = { default: cache };
    return store;
  };

  it("serves the second request from cache, keeping Vary and a private TTL", async () => {
    const store = installCache();
    const handler = markdownNegotiation({ cache: { ttlMs: 60_000 } });
    let calls = 0;
    const next = async () =>
      new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
    const request = (): Request => new Request(PAGE, { headers: { accept: "text/markdown" } });

    const first = await handler(request(), async () => {
      calls += 1;
      return next();
    });
    expect(await first.text()).toContain("# Doc");

    const second = await handler(request(), async () => {
      calls += 1;
      return next();
    });
    expect(calls).toBe(1);
    expect(await second.text()).toContain("# Doc");

    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("__aw_md=1");
    const stored = store.get(keys[0] as string);
    // Cache API 只认 max-age 当 TTL，private 阻止下游 CDN 存下同一份响应。
    expect(stored?.headers.get("cache-control")).toBe("max-age=60, private");
    expect(stored?.headers.get("set-cookie")).toBeNull();
    // 命中副本会直接回给客户端：缺 Vary 的 text/markdown 会被共享缓存按裸 URL
    // 存下来喂给浏览器——本包审计规则判 fail 的正是这个形态。
    expect(stored?.headers.get("vary")).toBe("Accept");
    expect(second.headers.get("vary")).toBe("Accept");
  });

  it("does not cache responses the origin marked as personalized", async () => {
    const store = installCache();
    const handler = markdownNegotiation({ cache: { ttlMs: 60_000 } });
    let calls = 0;
    const next = async () =>
      new Response(HTML, {
        status: 200,
        headers: { "content-type": "text/html", "set-cookie": "sid=1" },
      });
    const request = (): Request => new Request(PAGE, { headers: { accept: "text/markdown" } });

    await handler(request(), async () => {
      calls += 1;
      return next();
    });
    await handler(request(), async () => {
      calls += 1;
      return next();
    });

    expect(calls).toBe(2);
    expect(store.size).toBe(0);
  });

  it("keys the cache without tracking params and in a stable order", () => {
    expect(markdownCacheKey("https://example.com/p?utm_source=x&b=2&a=1")).toBe(
      "https://example.com/p?a=1&b=2&__aw_md=1",
    );
  });

  it("does not cache non-200 responses", async () => {
    const store = installCache();
    const handler = markdownNegotiation({ cache: { ttlMs: 60_000 } });
    const response = await handler(
      new Request(PAGE, { headers: { accept: "text/markdown" } }),
      async () =>
        new Response("missing", { status: 404, headers: { "content-type": "text/html" } }),
    );
    expect(response.status).toBe(404);
    expect(store.size).toBe(0);
  });
});
