import type { BenchmarkResult } from "./BenchmarkRunner.js";
import { stat, type ComparisonReport } from "./Comparison.js";

const f = (n: number | undefined, d = 1): string => (n === undefined || !Number.isFinite(n) ? "n/a" : n.toFixed(d));

/** One block in the format required by spec §38. `n/a` is printed for unmeasured values, never 0. */
export function formatBlock(title: string, runs: BenchmarkResult[]): string {
  const m = (k: keyof BenchmarkResult): number | undefined => stat(runs.map((r) => r[k]).filter((x): x is number => typeof x === "number"))?.mean;
  const fps = m("avgFps");
  const lines = [
    title,
    `FPS: ${fps === undefined ? "n/a (" + (runs[0]?.fpsUnavailableReason ?? "not measured") + ")" : f(fps)}`,
    `Frame time: ${f(m("avgFrameTimeMs"))} ms` + (m("frameTimeP95Ms") !== undefined ? `  (p95 ${f(m("frameTimeP95Ms"))} ms)` : ""),
    `CPU: ${f(m("cpuUsagePercent"), 0)}%`,
    `RAM: ${f((m("memoryUsageMb") ?? NaN) / 1024, 2)} GB`,
    `Swap I/O: ${f((m("swapInPerSecond") ?? 0) + (m("swapOutPerSecond") ?? 0), 1)} pages/s`,
    `(runs: ${runs.length}, backend: ${runs[0]?.graphicsBackend}, affinity: ${runs[0]?.cpuAffinity?.join(",") ?? "none"}, sched: ${runs[0]?.schedulerPolicy}/nice ${runs[0]?.niceLevel})`,
  ];
  return lines.join("\n");
}

export function formatComparison(r: ComparisonReport): string {
  const out: string[] = [`Comparison: ${r.labelA}  ->  ${r.labelB}`];
  const pad = (s: string, n: number): string => s.padEnd(n);
  out.push(pad("metric", 24) + pad(r.labelA.slice(0, 18), 20) + pad(r.labelB.slice(0, 18), 20) + pad("delta", 18) + "verdict");
  for (const m of r.metrics) {
    const a = m.a ? `${f(m.a.mean)}±${f(m.a.stddev)} (n=${m.a.n})` : "n/a";
    const b = m.b ? `${f(m.b.mean)}±${f(m.b.stddev)} (n=${m.b.n})` : "n/a";
    const d = m.delta === undefined ? "n/a" : `${m.delta >= 0 ? "+" : ""}${f(m.delta)} ${m.unit}` + (m.deltaPercent !== undefined ? ` (${m.deltaPercent >= 0 ? "+" : ""}${f(m.deltaPercent)}%)` : "");
    out.push(pad(m.metric, 24) + pad(a, 20) + pad(b, 20) + pad(d, 18) + m.verdict);
  }
  if (r.mismatches.length) out.push("", "NOT like-for-like (differences between the two sides):", ...r.mismatches.map((x) => `  - ${x}`));
  for (const n of r.notes) out.push(`note: ${n}`);
  out.push("Cause: unverified (Tangerine reports measurements, not explanations)");
  return out.join("\n");
}

export function formatResultLine(r: BenchmarkResult): string {
  return `${r.label} #${r.runIndex + 1}: fps=${f(r.avgFps)} p95=${f(r.frameTimeP95Ms)}ms cpu=${f(r.cpuUsagePercent, 0)}% ram=${f(r.memoryUsageMb, 0)}MB swap=${f(r.swapInPerSecond + r.swapOutPerSecond)}pg/s end=${r.endReason}`;
}
