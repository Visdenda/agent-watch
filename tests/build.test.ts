import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** 发布产物（crawler-directory T-i / EARS #14）：ESM + CJS + 双格式声明（.d.ts / .d.mts）可导入。 */

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

describe("agent-watch build", () => {
  it("emits importable ESM and CJS bundles with declarations", async () => {
    execFileSync(process.execPath, ["build.mjs"], { cwd: PACKAGE_DIR, stdio: "pipe" });

    for (const file of [
      "dist/index.mjs",
      "dist/index.cjs",
      "dist/index.d.ts",
      "dist/index.d.mts",
      "dist/node.mjs",
      "dist/node.cjs",
      "dist/node.d.ts",
      "dist/node.d.mts",
      "dist/hono.mjs",
      "dist/workers.mjs",
      "dist/next.mjs",
      "dist/markdown/index.mjs",
      "dist/markdown/index.cjs",
      "dist/markdown/index.d.ts",
      "dist/markdown/index.d.mts",
    ]) {
      expect(existsSync(join(PACKAGE_DIR, file)), file).toBe(true);
    }

    // 声明的相对说明符必须带扩展名（node16/nodenext 消费者解析要求）；
    // 源码保持无扩展名（Turbopack 不给我们这个包做 .js → .ts 改写），
    // 由 build.mjs 在 emit 后统一补 —— 这一条守的就是那步别被删掉。
    for (const file of ["dist/index.d.ts", "dist/node.d.ts", "dist/markdown/index.d.ts"]) {
      const declared = readFileSync(join(PACKAGE_DIR, file), "utf8");
      const specifiers = [...declared.matchAll(/from "(\.[^"]*)"/g)].map((match) => match[1]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier.endsWith(".js"), `${file}: ${specifier}`).toBe(true);
      }
    }

    const esm = (await import(pathToFileURL(join(PACKAGE_DIR, "dist/index.mjs")).href)) as {
      createAgentWatch?: unknown;
      markdownNegotiation?: unknown;
    };
    expect(typeof esm.createAgentWatch).toBe("function");

    const nodeAdapter = (await import(pathToFileURL(join(PACKAGE_DIR, "dist/node.mjs")).href)) as {
      nodeMiddleware?: unknown;
    };
    expect(typeof nodeAdapter.nodeMiddleware).toBe("function");

    const cjs = require(join(PACKAGE_DIR, "dist/index.cjs")) as {
      createAgentWatch?: unknown;
      markdownNegotiation?: unknown;
    };
    expect(typeof cjs.createAgentWatch).toBe("function");
  });
});
