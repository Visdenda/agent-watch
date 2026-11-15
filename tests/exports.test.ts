import { describe, expect, it } from "vitest";

import * as main from "@visdenda/agent-watch";
import * as hono from "@visdenda/agent-watch/hono";
import * as markdown from "@visdenda/agent-watch/markdown";
import * as next from "@visdenda/agent-watch/next";
import * as node from "@visdenda/agent-watch/node";
import * as workers from "@visdenda/agent-watch/workers";

/**
 * 1.0 导入面契约（allowlist）：导出名是承诺，新增/删除都必须先改这份快照。
 * 根入口只有核心工厂与协议工具；适配器按请求形状分布在子路径里——
 * 根入口再导出一次会让每个消费者都为用不到的适配器付费，也让「在哪接」重新含糊。
 * 只列运行时值（类型在编译期擦除），顺序按字典序比较。
 */
const MAIN_EXPORTS = [
  "AI_REFERRER_HOSTS",
  "MAX_BATCH_BODY_BYTES",
  "MAX_BATCH_EVENTS",
  "createAgentWatch",
  "isAiReferrerHost",
  "normalizeUtmSource",
];

const MARKDOWN_EXPORTS = [
  "DEFAULT_EXCLUDE_PATTERNS",
  "MARKDOWN_HTML_BUDGET_BYTES",
  "MARKDOWN_TIMEOUT_MS",
  "buildMarkdownDocument",
  "contentRoot",
  "extractHead",
  "fragmentToMarkdown",
  "isMarkdownPagePath",
  "markdownCacheKey",
  "markdownNegotiation",
  "mergeVary",
  "resolveMarkdownOptions",
  "stripChrome",
  "toMarkdownResponse",
  "wantsMarkdown",
];

describe("agent-watch public exports", () => {
  it("keeps the main entry allowlist", () => {
    expect(Object.keys(main).sort()).toEqual(MAIN_EXPORTS);
  });

  it("keeps one adapter per request-shape entry", () => {
    expect(Object.keys(hono)).toEqual(["contextMiddleware"]);
    expect(Object.keys(node)).toEqual(["nodeMiddleware"]);
    expect(Object.keys(next)).toEqual(["requestMiddleware"]);
    expect(Object.keys(workers)).toEqual(["wrapFetch"]);
  });

  it("keeps the markdown entry allowlist", () => {
    expect(Object.keys(markdown).sort()).toEqual(MARKDOWN_EXPORTS);
  });

  it("has no default export on any entry", () => {
    for (const entry of [main, hono, markdown, next, node, workers]) {
      expect("default" in entry).toBe(false);
    }
  });
});
