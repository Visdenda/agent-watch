#!/usr/bin/env node
/**
 * 发布脚本（维护者用）。
 *
 * 为什么需要暂存目录：npm 只认 `publishConfig` 里的 registry/access/tag 这几个键，
 * **不认** `publishConfig.exports/main/types`。0.2.0 就是这么发坏的——registry 上的
 * package.json 仍写着 `exports: "./src/index.ts"`，而 tarball 只装了 dist，装上去
 * 解析即失败。
 *
 * 仓库内的包必须导出 src（全仓无构建，Next/Worker 直接吃源码），发布出去必须导出
 * dist，两个需求没法共用一份 package.json：所以 build 完之后把 dist 版清单写进
 * 临时目录，用 `npm publish <dir>` 发布。仓库里的 package.json 一个字节都不动。
 *
 * 发布门禁（每次 publish 都跑，`--check` 只跑门禁）：
 * - publint：清单与磁盘文件对不上、条件顺序写错、双格式类型格式错；
 * - attw：node10 / node16 CJS / node16 ESM / bundler 四种解析路径的类型是否正确；
 * - 安装 smoke：真实 tarball 装进一个消费者，ESM import、CJS require、TS node16 各编译一次。
 * - Workers bundle：同一份 tarball 以 `platform: "browser"` 打包并真正 import 一次，
 *   任何 Node 内置模块或 Node 专属全局都会在这一步失败。
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build as esbuild } from "esbuild";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const passthrough = args.filter((arg) => arg !== "--check");
const dryRun = passthrough.includes("--dry-run");

execFileSync(process.execPath, [join(root, "build.mjs")], { cwd: root, stdio: "inherit" });

const stage = mkdtempSync(join(tmpdir(), "agent-watch-publish-"));
for (const entry of ["dist", "README.md", "CHANGELOG.md", "LICENSE"]) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}

/**
 * 只保留发布面需要的字段：devDependencies/scripts/仓库内的 src exports 一律不进去。
 *
 * `type: "commonjs"` 是给类型检查器看的：`.d.ts` 按 CJS 解释、`.d.mts` 按 ESM 解释。
 * 运行时文件是显式的 `.mjs`/`.cjs`，不受这个字段影响。两套类型分条件挂载，
 * 否则 ESM 消费者会拿到「CJS 类型 + ESM 实现」（FalseCJS）——0.3.0 的真实缺陷。
 */
/** 每个入口的条件导出：`.mjs` 配 `.d.mts`，`.cjs` 配 `.d.ts`（FalseCJS 反例见 0.3.0）。 */
const entryExport = (entry) => ({
  import: { types: `./dist/${entry}.d.mts`, default: `./dist/${entry}.mjs` },
  require: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.cjs` },
});

const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: source.license,
  keywords: source.keywords,
  homepage: source.homepage,
  repository: source.repository,
  bugs: source.bugs,
  engines: source.engines,
  sideEffects: source.sideEffects,
  type: "commonjs",
  main: "./dist/index.cjs",
  module: "./dist/index.mjs",
  types: "./dist/index.d.ts",
  exports: {
    ".": entryExport("index"),
    "./node": entryExport("node"),
    "./hono": entryExport("hono"),
    "./workers": entryExport("workers"),
    "./next": entryExport("next"),
    "./markdown": entryExport("markdown/index"),
    "./package.json": "./package.json",
  },
  // node10（老 moduleResolution）不读 exports，子路径要靠 typesVersions 才解析得到。
  // 0.3.0 的 `./markdown` 在这一档是 404。
  typesVersions: {
    "*": {
      markdown: ["./dist/markdown/index.d.ts"],
      node: ["./dist/node.d.ts"],
      hono: ["./dist/hono.d.ts"],
      workers: ["./dist/workers.d.ts"],
      next: ["./dist/next.d.ts"],
    },
  },
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 清单里引用的每个文件都必须在暂存目录里真实存在。0.2.0 的教训：exports 指向
// ./src/*.ts（仓库里有、tarball 里没有），registry 收下、装到就解析失败。
const missing = [];
const requireFile = (rel) => {
  if (!existsSync(join(stage, rel))) missing.push(rel);
};
const walkStrings = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const child of Object.values(value)) walkStrings(child, out);
  }
  return out;
};
for (const rel of walkStrings([manifest.main, manifest.module, manifest.types])) requireFile(rel);
for (const rel of walkStrings(manifest.exports)) requireFile(rel);
for (const rel of walkStrings(manifest.typesVersions)) requireFile(rel);
if (missing.length > 0) {
  throw new Error(`staged manifest points at missing files: ${missing.join(", ")}`);
}

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });

/**
 * 从本地 node_modules/.bin 取 bin：私有仓（pnpm）与公开镜像仓（npm）都会为直接
 * devDependency 创建 shim，不依赖 pnpm 命令本身。以前写死 `pnpm exec publint`
 * 会让镜像仓 CI 直接 ENOENT（0.5.0 首次公开镜像的失败原因）。
 */
const binOf = (binName) => {
  const candidate = join(root, "node_modules", ".bin", binName);
  if (!existsSync(candidate)) {
    throw new Error(`missing ${binName} in node_modules/.bin — run npm install first`);
  }
  return candidate;
};

console.log("[agent-watch] gate: publint");
run(binOf("publint"), [stage]);

console.log("[agent-watch] gate: arethetypeswrong (node10 / node16 / bundler)");
run(binOf("attw"), [stage, "--pack", "--profile", "strict"]);

console.log("[agent-watch] gate: install smoke (ESM + CJS + TS node16)");
const work = mkdtempSync(join(tmpdir(), "agent-watch-consumer-"));
const packDir = join(work, "pack");
mkdirSync(packDir);
run("npm", ["pack", stage, "--pack-destination", packDir]);
const tarballName = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
if (!tarballName) throw new Error("npm pack produced no tarball");
const tarball = join(packDir, tarballName);

const consumer = join(work, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "agent-watch-consumer", private: true, type: "module" }, null, 2)}\n`,
);
run("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
  cwd: consumer,
});

/** Workers bundle（1.0 出门条件）：browser 平台打包能挡住 Node 内置模块混入发布产物。 */
console.log("[agent-watch] gate: workers bundle");
writeFileSync(
  join(consumer, "worker.mjs"),
  `import { createAgentWatch } from "@visdenda/agent-watch";
import { wrapFetch } from "@visdenda/agent-watch/workers";
import { nodeMiddleware } from "@visdenda/agent-watch/node";
import { contextMiddleware } from "@visdenda/agent-watch/hono";
import { requestMiddleware } from "@visdenda/agent-watch/next";
import { markdownNegotiation } from "@visdenda/agent-watch/markdown";
const watch = createAgentWatch({
  token: "vdc_test",
  fetch: async () => new Response(null, { status: 204 }),
});
const handler = wrapFetch({ token: "vdc_test" }, async () => new Response("ok"));
export const workerReady =
  typeof watch.probe === "function" &&
  typeof handler === "function" &&
  typeof nodeMiddleware === "function" &&
  typeof contextMiddleware === "function" &&
  typeof requestMiddleware === "function" &&
  typeof markdownNegotiation === "function";
`,
);
await esbuild({
  entryPoints: [join(consumer, "worker.mjs")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: join(consumer, "worker.bundle.mjs"),
  logLevel: "silent",
});
const workerBundle = await import(pathToFileURL(join(consumer, "worker.bundle.mjs")).href);
if (workerBundle.workerReady !== true) throw new Error("workers bundle failed to initialize");

writeFileSync(
  join(consumer, "esm.mjs"),
  `import { createAgentWatch } from "@visdenda/agent-watch";
import { wrapFetch } from "@visdenda/agent-watch/workers";
import { nodeMiddleware } from "@visdenda/agent-watch/node";
import { contextMiddleware } from "@visdenda/agent-watch/hono";
import { requestMiddleware } from "@visdenda/agent-watch/next";
import { markdownNegotiation } from "@visdenda/agent-watch/markdown";
for (const [name, value] of Object.entries({
  createAgentWatch,
  wrapFetch,
  nodeMiddleware,
  contextMiddleware,
  requestMiddleware,
  markdownNegotiation,
})) {
  if (typeof value !== "function") throw new Error(\`missing ESM export: \${name}\`);
}
`,
);
run(process.execPath, ["esm.mjs"], { cwd: consumer });

writeFileSync(
  join(consumer, "cjs.cjs"),
  `const { createAgentWatch } = require("@visdenda/agent-watch");
const { wrapFetch } = require("@visdenda/agent-watch/workers");
const { nodeMiddleware } = require("@visdenda/agent-watch/node");
const { contextMiddleware } = require("@visdenda/agent-watch/hono");
const { requestMiddleware } = require("@visdenda/agent-watch/next");
const { markdownNegotiation } = require("@visdenda/agent-watch/markdown");
for (const [name, value] of Object.entries({
  createAgentWatch,
  wrapFetch,
  nodeMiddleware,
  contextMiddleware,
  requestMiddleware,
  markdownNegotiation,
})) {
  if (typeof value !== "function") throw new Error(\`missing CJS export: \${name}\`);
}
`,
);
run(process.execPath, ["cjs.cjs"], { cwd: consumer });

const typeProbe = `import { createAgentWatch, type AgentWatchConfig } from "@visdenda/agent-watch";
import { wrapFetch } from "@visdenda/agent-watch/workers";
import { nodeMiddleware } from "@visdenda/agent-watch/node";
import { contextMiddleware } from "@visdenda/agent-watch/hono";
import { requestMiddleware } from "@visdenda/agent-watch/next";
import { markdownNegotiation } from "@visdenda/agent-watch/markdown";
const config: AgentWatchConfig = { token: "vdc_test" };
const watch = createAgentWatch(config);
void watch;
void wrapFetch(config, async () => new Response("ok"));
void nodeMiddleware;
void contextMiddleware;
void requestMiddleware;
void markdownNegotiation();
`;
writeFileSync(join(consumer, "consumer.mts"), typeProbe);
writeFileSync(join(consumer, "consumer.cts"), typeProbe);
// 从消费者目录跑 tsc：仓库根的 tsconfig 不会被加载，`.d.mts`/`.d.ts` 的分支由
// node16 解析规则真正走一遍。TS 7 的 exports 不再暴露 ./bin/tsc，仍从 package.json#bin 取。
const typescriptPackagePath = require.resolve("typescript/package.json");
const typescriptBin = JSON.parse(readFileSync(typescriptPackagePath, "utf8")).bin;
run(
  process.execPath,
  [
    join(dirname(typescriptPackagePath), typescriptBin.tsc),
    "--noEmit",
    "--strict",
    "--target",
    "es2022",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "consumer.mts",
    "consumer.cts",
  ],
  { cwd: consumer },
);

if (checkOnly || dryRun) {
  console.log(`[agent-watch] stage: ${stage}`);
  console.log(JSON.stringify(manifest.exports, null, 2));
}
if (checkOnly) {
  console.log("[agent-watch] check-only: all gates passed");
  process.exit(0);
}

// 供应链可选：CI 里显式打开（需要 id-token: write 与公开仓）。默认关，避免本地/无 OIDC 的
// CI 因为 --provenance 直接失败。
const provenance = !dryRun && process.env.AGENT_WATCH_PROVENANCE === "true";
if (provenance) console.log("[agent-watch] npm provenance enabled");

execFileSync(
  "npm",
  ["publish", stage, "--access", "public", ...(provenance ? ["--provenance"] : []), ...passthrough],
  {
    cwd: root,
    stdio: "inherit",
  },
);
