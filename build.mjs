import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { build } from "esbuild";

/**
 * 对外发布产物（本仓唯一需要构建的包）：
 * - dist/index.mjs + dist/markdown/index.mjs（ESM）
 * - dist/index.cjs + dist/markdown/index.cjs（CJS）
 * - dist/**\/*.d.ts（tsc declaration emit）
 *
 * 仓内消费仍走 package.json 的 exports（源码）；发布时 pnpm 用
 * publishConfig.exports 覆盖为 dist（见 package.json）。
 */
const require = createRequire(import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const ENTRY_POINTS = {
  index: "src/index.ts",
  node: "src/node.ts",
  hono: "src/hono.ts",
  workers: "src/workers.ts",
  next: "src/next.ts",
  "markdown/index": "src/markdown/index.ts",
};

const common = {
  entryPoints: ENTRY_POINTS,
  bundle: true,
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
  // 发布产物直接压缩：消费者 bundler 仍会再压，但 unpkg / 直接 import dist 的
  // 原始体积和 tarball 体积减半（0.4.1 前 index.mjs 15.9 kB → 7.6 kB）。
  // bundlephobia 的 min+gzip 数字本来就会自行压缩，这条不改变它。
  minify: true,
  // Workers 运行时读不到 package.json：版本在构建时注入（probe 的 x-agent-watch 头）。
  define: { __AGENT_WATCH_VERSION__: JSON.stringify(version) },
};

rmSync("dist", { recursive: true, force: true });

await Promise.all([
  build({ ...common, outdir: "dist", format: "esm", outExtension: { ".js": ".mjs" } }),
  build({ ...common, outdir: "dist", format: "cjs", outExtension: { ".js": ".cjs" } }),
]);

// TS 7 的 exports 不再暴露 ./bin/tsc，统一从 package.json#bin 解析（5/6/7 通用）。
const typescriptPackagePath = require.resolve("typescript/package.json");
const typescriptBin = JSON.parse(readFileSync(typescriptPackagePath, "utf8")).bin;

execFileSync(
  process.execPath,
  [join(dirname(typescriptPackagePath), typescriptBin.tsc), "-p", "tsconfig.build.json"],
  {
    stdio: "inherit",
  },
);

/**
 * 声明侧的相对说明符补 `.js`，只补产物、不改源码。
 *
 * 两个消费方对说明符的要求正好相反：
 * - 仓内消费走 `exports` 的 `src/*.ts`，由 Turbopack / esbuild / tsc(Bundler) 直接吃源码。
 *   Turbopack 对我们这个 app root 之外的包**不做** `.js` → `.ts` 扩展名改写，
 *   源码里写 `./x.js` 会直接 Module not found（0.4.0 发布时踩过）；
 * - 发布出去的是 `dist`，node16/nodenext 消费者解析声明时相对说明符**必须**带扩展名
 *   （否则 tsc 报 TS2835，attw / publint 也会挂）。
 *
 * 所以源码保持无扩展名，声明在 emit 之后统一补齐；`.d.mts` 里的 `./x.js`
 * 会落到同目录的 `x.d.ts`，无需再复制整棵声明树。
 */
const addJsSpecifiers = (source) =>
  source.replace(/(\bfrom\s*")(\.\.?\/[^"]*)(")/g, (match, head, specifier, tail) =>
    /\.[cm]?[jt]sx?$/.test(specifier) ? match : `${head}${specifier}.js${tail}`,
  );

const declarationFiles = readdirSync("dist", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => join("dist", file));

for (const file of declarationFiles) {
  const source = readFileSync(file, "utf8");
  const rewritten = addJsSpecifiers(source);
  if (rewritten !== source) writeFileSync(file, rewritten);
}

/**
 * 双格式类型：`.d.ts` 在无 `type: module` 的包里被解释为 CJS，`import` 条件下
 * 指向它会让 ESM 消费者看到「CJS 类型 + ESM 实现」（publint / attw 的 FalseCJS）。
 * 入口再复制一份 `.d.mts` 给 `import` 分支；内容相同，格式由扩展名决定。
 */
for (const entry of ["index", "node", "hono", "workers", "next", "markdown/index"]) {
  copyFileSync(join("dist", `${entry}.d.ts`), join("dist", `${entry}.d.mts`));
}

console.log("[agent-watch] dist: ESM + CJS + d.ts + d.mts");
