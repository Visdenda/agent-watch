import { defineConfig } from "vitest/config";

const src = (path: string): string => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@visdenda\/agent-watch$/, replacement: src("./src/index.ts") },
      { find: /^@visdenda\/agent-watch\/markdown$/, replacement: src("./src/markdown/index.ts") },
      { find: /^@visdenda\/agent-watch\/node$/, replacement: src("./src/node.ts") },
      { find: /^@visdenda\/agent-watch\/hono$/, replacement: src("./src/hono.ts") },
      { find: /^@visdenda\/agent-watch\/workers$/, replacement: src("./src/workers.ts") },
      { find: /^@visdenda\/agent-watch\/next$/, replacement: src("./src/next.ts") },
    ],
  },
  test: { environment: "node" },
});
