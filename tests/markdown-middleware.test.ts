import { describe, expect, it } from "vitest";

import { markdownNegotiation } from "@visdenda/agent-watch/markdown";

const PAGE = "https://example.com/docs/page";
const HTML_BODY = `<html><head><title>Doc</title></head><body><h1>Doc</h1><p>Body text.</p></body></html>`;

const htmlResponse = () =>
  new Response(HTML_BODY, { status: 200, headers: { "content-type": "text/html" } });

/**
 * T-b（FR-AEO-27 EARS #4/#7）：内部重取恰好一次且 Accept 改写；失败回退 HTML 且状态码不变。
 */
describe("markdownNegotiation middleware（T-b）", () => {
  it("non-negotiated requests pass through untouched (one call, original Accept)", async () => {
    const calls: Request[] = [];
    const handler = markdownNegotiation();
    const response = await handler(
      new Request(PAGE, { headers: { accept: "text/html" } }),
      async (request) => {
        calls.push(request);
        return htmlResponse();
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("accept")).toBe("text/html");
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("negotiated request does exactly one internal re-fetch with Accept: text/html", async () => {
    const calls: Request[] = [];
    const handler = markdownNegotiation();
    const response = await handler(
      new Request(PAGE, { headers: { accept: "text/markdown" } }),
      async (request) => {
        calls.push(request);
        return htmlResponse();
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("accept")).toBe("text/html");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toContain("# Doc");
  });

  it("conversion failure falls back to HTML with the original status", async () => {
    const handler = markdownNegotiation();
    const response = await handler(
      new Request(PAGE, { headers: { accept: "text/markdown" } }),
      async () => new Response("nope", { status: 500, headers: { "content-type": "text/html" } }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("falls back with the full HTML body when conversion is skipped", async () => {
    // 转换会消费响应体：用 clone 转换，回退才能拿到完整 HTML 而不是空 body。
    const handler = markdownNegotiation({ budgetBytes: 100 });
    const body = `<html><body><p>${"z".repeat(200)}</p></body></html>`;
    const response = await handler(
      new Request(PAGE, { headers: { accept: "text/markdown" } }),
      async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(body);
  });

  it("path configuration is respected inside the middleware", async () => {
    const handler = markdownNegotiation({ markdownPaths: ["/docs"] });
    const blocked = await handler(
      new Request("https://example.com/dashboard/mine", { headers: { accept: "text/markdown" } }),
      async () => htmlResponse(),
    );
    expect(blocked.headers.get("content-type")).toContain("text/html");
  });

  it("wrapFetch adapts the (request, env) signature", async () => {
    const handler = markdownNegotiation();
    const worker = handler.wrapFetch(async () => htmlResponse());
    const response = await worker(
      new Request(PAGE, { headers: { accept: "text/markdown" } }),
      {} as never,
    );
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });
});
