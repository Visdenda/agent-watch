import { describe, expect, it } from "vitest";

import {
  isMarkdownPagePath,
  MARKDOWN_HTML_BUDGET_BYTES,
  mergeVary,
  toMarkdownResponse,
  wantsMarkdown,
} from "@visdenda/agent-watch/markdown";

const request = (accept: string, init?: RequestInit) =>
  new Request("https://example.com/docs/page", { ...init, headers: { accept } });

const html = (body: string, init?: { status?: number; headers?: Record<string, string> }) =>
  new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init?.headers ?? {}) },
  });

/**
 * T-a（FR-AEO-27 EARS #1–#8）：q 值协商、路径配置、转换、预算/类型回退、响应头契约。
 */
describe("agent-watch markdown negotiation（T-a）", () => {
  it("q-value matrix: explicit markdown wins ties, loses to higher html q, zero disables", () => {
    expect(wantsMarkdown(request("text/markdown"))).toBe(true);
    expect(wantsMarkdown(request("text/markdown, text/html;q=0.9"))).toBe(true);
    expect(wantsMarkdown(request("text/markdown;q=0.8, text/html;q=0.5"))).toBe(true);
    expect(wantsMarkdown(request("text/html;q=0.9, text/markdown;q=0.5"))).toBe(false);
    expect(wantsMarkdown(request("text/markdown;q=0"))).toBe(false);
    // 非 GET / Range 不转换
    expect(wantsMarkdown(request("text/markdown", { method: "POST" }))).toBe(false);
    expect(
      wantsMarkdown(
        new Request("https://example.com/docs", {
          headers: { accept: "text/markdown", range: "bytes=0-10" },
        }),
      ),
    ).toBe(false);
  });

  it("Vary is merged, never duplicated", () => {
    expect(mergeVary(null)).toBe("Accept");
    expect(mergeVary("Accept-Encoding")).toBe("Accept-Encoding, Accept");
    expect(mergeVary("accept")).toBe("accept");
    expect(mergeVary("Accept-Encoding, accept")).toBe("Accept-Encoding, accept");
  });

  it("path config: explicit prefixes, default excludes for API/static assets", () => {
    expect(isMarkdownPagePath("/any/page")).toBe(true); // 缺省全站
    expect(isMarkdownPagePath("/api/x")).toBe(false);
    expect(isMarkdownPagePath("/_next/static/x.js")).toBe(false);
    expect(isMarkdownPagePath("/cdn-cgi/trace")).toBe(false);
    expect(isMarkdownPagePath("/sitemap.xml")).toBe(false);
    expect(isMarkdownPagePath("/docs/api", { markdownPaths: ["/docs"] })).toBe(true);
    expect(isMarkdownPagePath("/blog/x", { markdownPaths: ["/docs"] })).toBe(false);
    // 前缀按整段匹配：`"/"` 只匹配首页，想全站就别传 markdownPaths。
    expect(isMarkdownPagePath("/", { markdownPaths: ["/"] })).toBe(true);
    expect(isMarkdownPagePath("/blog/x", { markdownPaths: ["/"] })).toBe(false);
    expect(isMarkdownPagePath("/docs2", { markdownPaths: ["/docs"] })).toBe(false);
  });

  it("converts nested lists and GFM tables, keeps content-signal", async () => {
    const response = await toMarkdownResponse(
      html(
        `<html><head><title>T</title></head><body><ul><li>a<ul><li>b</li></ul></li></ul>
         <table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>c1</td><td>c2</td></tr></tbody></table></body></html>`,
        { headers: { "content-signal": "ai-train=no", vary: "Accept-Encoding" } },
      ),
      "https://example.com/docs/page",
    );
    expect(response?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response?.headers.get("vary")).toBe("Accept-Encoding, Accept");
    expect(response?.headers.get("content-signal")).toBe("ai-train=no");
    expect(Number(response?.headers.get("x-markdown-tokens"))).toBeGreaterThan(0);
    const body = (await response?.text()) ?? "";
    expect(body).toContain("| H1 | H2 |");
    expect(body).toContain("| c1 | c2 |");
    expect(body).toMatch(/\*\*|[-*] a/);
  });

  it("leaves content-signal absent when the origin never declared it", async () => {
    // 只保留不注入：缺省补 ai-train=yes 等于替站点主改训练授权，且会与 robots.txt
    // 的 Content-Signal 矛盾（本站曾因此线上自相矛盾）。
    const response = await toMarkdownResponse(
      html(`<html><head><title>T</title></head><body><p>plain</p></body></html>`),
      "https://example.com/page",
    );
    expect(response?.headers.has("content-signal")).toBe(false);
    expect(response?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("falls back on non-2xx, non-HTML, and over-budget payloads (EARS #5)", async () => {
    expect(
      await toMarkdownResponse(html("<h1>x</h1>", { status: 404 }), "https://example.com/"),
    ).toBeNull();
    expect(
      await toMarkdownResponse(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        "https://example.com/",
      ),
    ).toBeNull();
    const oversized = `<html><body><p>${"x".repeat(MARKDOWN_HTML_BUDGET_BYTES + 1)}</p></body></html>`;
    expect(await toMarkdownResponse(html(oversized), "https://example.com/")).toBeNull();
    // 显式预算同样生效
    expect(
      await toMarkdownResponse(
        html(`<html><body>${"y".repeat(200)}</body></html>`),
        "https://example.com/",
        {
          budgetBytes: 100,
        },
      ),
    ).toBeNull();
  });
});
