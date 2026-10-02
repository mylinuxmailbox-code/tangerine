import type { BenchmarkResult } from "./BenchmarkRunner.js";
import { baselineMismatches } from "./Baseline.js";

export interface Stat {
  n: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export function stat(values: number[]): Stat | undefined {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return undefined;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0; // sample variance
  return { n: v.length, mean, stddev: Math.sqrt(variance), min: Math.min(...v), max: Math.max(...v) };
}

export type Verdict = "higher" | "lower" | "within-noise" | "unverified-single-run" | "n/a";

export interface MetricComparison {
  metric: string;
  unit: string;
  higherIsBetter: boolean | undefined;
  a?: Stat;
  b?: Stat;
  delta?: number;
  deltaPercent?: number;
  verdict: Verdict;
}

export interface ComparisonReport {
  labelA: string;
  labelB: string;
  metrics: MetricComparison[];
  mismatches: string[];
  notes: string[];
}

const METRICS: { key: keyof BenchmarkResult; name: string; unit: string; hib?: boolean }[] = [
  { key: "avgFps", name: "FPS (avg)", unit: "fps", hib: true },
  { key: "minFps", name: "FPS (min)", unit: "fps", hib: true },
  { key: "avgFrameTimeMs", name: "Frame time (avg)", unit: "ms", hib: false },
  { key: "frameTimeP95Ms", name: "Frame time (p95)", unit: "ms", hib: false },
  { key: "frameTimeStdDevMs", name: "Frame time (stddev)", unit: "ms", hib: false },
  { key: "cpuUsagePercent", name: "CPU", unit: "%" },
  { key: "memoryUsageMb", name: "RAM used", unit: "MB" },
  { key: "swapInPerSecond", name: "Swap-in", unit: "pages/s" },
  { key: "swapOutPerSecond", name: "Swap-out", unit: "pages/s" },
  { key: "cpuFreqMhzAvg", name: "CPU clock (avg)", unit: "MHz" },
  { key: "startupTimeMs", name: "Control-plane startup", unit: "ms", hib: false },
];

/**
 * Compares two sets of runs as DISTRIBUTIONS (spec §36). A difference is only called
 * higher/lower when it exceeds twice the larger run-to-run standard deviation; with one run
 * per side there is no noise estimate, so the verdict is "unverified". No "winner" is ever declared.
 */
export function compareRuns(a: BenchmarkResult[], b: BenchmarkResult[]): ComparisonReport {
  const notes: string[] = [];
  const metrics: MetricComparison[] = [];
  for (const m of METRICS) {
    const sa = stat(a.map((r) => r[m.key]).filter((x): x is number => typeof x === "number"));
    const sb = stat(b.map((r) => r[m.key]).filter((x): x is number => typeof x === "number"));
    if (!sa || !sb) {
      metrics.push({ metric: m.name, unit: m.unit, higherIsBetter: m.hib, a: sa, b: sb, verdict: "n/a" });
      continue;
    }
    const delta = sb.mean - sa.mean;
    const pct = sa.mean !== 0 ? (delta / sa.mean) * 100 : undefined;
    let verdict: Verdict;
    if (sa.n < 2 || sb.n < 2) verdict = "unverified-single-run";
    else if (Math.abs(delta) <= 2 * Math.max(sa.stddev, sb.stddev)) verdict = "within-noise";
    else verdict = delta > 0 ? "higher" : "lower";
    metrics.push({ metric: m.name, unit: m.unit, higherIsBetter: m.hib, a: sa, b: sb, delta, deltaPercent: pct, verdict });
  }
  const mismatches: string[] = [];
  const a0 = a[0];
  const b0 = b[0];
  if (a0 && b0) mismatches.push(...baselineMismatches(a0.system, b0.system));
  // ±2% (min 250 ms): timer jitter is not a methodology difference
  if (a0 && b0 && Math.abs(a0.durationMs - b0.durationMs) > Math.max(250, 0.02 * Math.max(a0.durationMs, b0.durationMs))) mismatches.push(`duration: ${a0.durationMs} ms vs ${b0.durationMs} ms`);
  if (a.length < 3 || b.length < 3) notes.push("fewer than 3 runs per side: run-to-run variance is poorly estimated");
  if (metrics.find((x) => x.metric === "FPS (avg)")?.verdict === "n/a") notes.push("FPS not measured on one or both sides (no frame timing source)");
  return { labelA: a0?.label ?? "A", labelB: b0?.label ?? "B", metrics, mismatches, notes };
}
