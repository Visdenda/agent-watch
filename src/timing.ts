/**
 * 单调时钟：`Date.now()` 会被 NTP 校时/系统休眠跳变影响，`dur` 是耗时不是墙钟。
 * 只在本包内部使用，不进公开入口（`index.ts` 不导出）。
 */
export const nowMs = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
};
