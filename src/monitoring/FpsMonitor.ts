import { ok, unavailable, type Metric } from "./Metric.js";
import type { Sampler } from "./MonitorManager.js";
import type { MetricsStore } from "./MetricsStore.js";

export interface FpsStats {
  /** "frame-times": real per-frame durations. "fps-reports": only periodic FPS numbers (frame-time stats are derived). */
  source: "frame-times" | "fps-reports";
  instantFps: number;
  avgFps: number;
  minFps: number;
  avgFrameTimeMs: number;
  frameTimeP95Ms: number;
  frameTimeStdDevMs: number;
  /** Frames longer than 2x the median frame time (a stutter heuristic, not a vsync-miss count). */
  droppedFrames: number;
  samples: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/** Parses a line of workload/driver output for frame statistics. Returns nothing rather than guessing. */
export function parseFrameLine(line: string): { fps?: number; frameTimeMs?: number } | undefined {
  const ft = /frame[\s_-]*time\D{0,6}([0-9]+(?:\.[0-9]+)?)\s*ms/i.exec(line);
  if (ft?.[1]) return { frameTimeMs: Number(ft[1]) };
  const fps = /\bfps\b\D{0,6}([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*fps\b/i.exec(line);
  const v = fps?.[1] ?? fps?.[2];
  if (v !== undefined) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 10_000) return { fps: n };
  }
  return undefined;
}

/**
 * Accumulates frame data from a real source. Bounded memory (ring of the last N entries).
 * Never invents data: with zero samples, snapshot() is undefined.
 */
export class FrameStatsAccumulator {
  private frameTimes: number[] = [];
  private fpsReports: number[] = [];
  private lifetimeFrameTimes: number[] = [];
  private lifetimeFps: number[] = [];

  constructor(private readonly windowFrames = 600, private readonly lifetimeCap = 20_000) {}

  addFrameTime(ms: number): void {
    if (!(ms > 0 && ms < 10_000)) return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > this.windowFrames) this.frameTimes.shift();
    this.lifetimeFrameTimes.push(ms);
    if (this.lifetimeFrameTimes.length > this.lifetimeCap) this.lifetimeFrameTimes.shift();
  }

  addFpsReport(fps: number): void {
    if (!(fps > 0)) return;
    this.fpsReports.push(fps);
    if (this.fpsReports.length > 600) this.fpsReports.shift();
    this.lifetimeFps.push(fps);
    if (this.lifetimeFps.length > this.lifetimeCap) this.lifetimeFps.shift();
  }

  reset(): void {
    this.frameTimes = [];
    this.fpsReports = [];
    this.lifetimeFrameTimes = [];
    this.lifetimeFps = [];
  }

  get hasData(): boolean {
    return this.lifetimeFrameTimes.length > 0 || this.lifetimeFps.length > 0;
  }

  /** `lifetime`: over the whole run (benchmark); otherwise over the recent window (live UI). */
  snapshot(lifetime = false): FpsStats | undefined {
    const ft = lifetime ? this.lifetimeFrameTimes : this.frameTimes;
    if (ft.length >= 2) return statsFromFrameTimes(ft);
    const rep = lifetime ? this.lifetimeFps : this.fpsReports;
    if (rep.length) return statsFromFpsReports(rep);
    return undefined;
  }
}

function statsFromFrameTimes(ft: readonly number[]): FpsStats {
  const sorted = [...ft].sort((a, b) => a - b);
  const mean = ft.reduce((a, b) => a + b, 0) / ft.length;
  const variance = ft.reduce((a, b) => a + (b - mean) ** 2, 0) / ft.length;
  const median = percentile(sorted, 50);
  const worst = sorted[sorted.length - 1] as number;
  return {
    source: "frame-times",
    instantFps: 1000 / (ft[ft.length - 1] as number),
    avgFps: 1000 / mean, // harmonic: total frames / total time
    minFps: 1000 / worst,
    avgFrameTimeMs: mean,
    frameTimeP95Ms: percentile(sorted, 95),
    frameTimeStdDevMs: Math.sqrt(variance),
    droppedFrames: ft.filter((x) => x > 2 * median).length,
    samples: ft.length,
  };
}

function statsFromFpsReports(rep: readonly number[]): FpsStats {
  const times = rep.map((f) => 1000 / f);
  const sorted = [...times].sort((a, b) => a - b);
  const meanFps = rep.reduce((a, b) => a + b, 0) / rep.length;
  const meanFt = times.reduce((a, b) => a + b, 0) / times.length;
  const variance = times.reduce((a, b) => a + (b - meanFt) ** 2, 0) / times.length;
  return {
    source: "fps-reports",
    instantFps: rep[rep.length - 1] as number,
    avgFps: meanFps,
    minFps: Math.min(...rep),
    avgFrameTimeMs: meanFt,
    frameTimeP95Ms: percentile(sorted, 95),
    frameTimeStdDevMs: Math.sqrt(variance),
    droppedFrames: 0,
    samples: rep.length,
  };
}

/** Publishes accumulator state at the FPS interval. Without a source it reports why FPS is unavailable. */
export class FpsMonitor implements Sampler {
  readonly name = "fps";
  readonly acc = new FrameStatsAccumulator();
  constructor(
    private readonly store: MetricsStore,
    private readonly sourceDescription: string | undefined,
  ) {}

  /** Entry point for sources: stderr parsers, application-provided metrics, runtime adapters. */
  ingestLine(line: string): void {
    const r = parseFrameLine(line);
    if (!r) return;
    if (r.frameTimeMs !== undefined) this.acc.addFrameTime(r.frameTimeMs);
    else if (r.fps !== undefined) this.acc.addFpsReport(r.fps);
  }

  metric(): Metric<FpsStats> {
    const s = this.acc.snapshot();
    if (s) return ok(s);
    return unavailable(this.sourceDescription ? `waiting for frame data from ${this.sourceDescription}` : "No supported frame timing source");
  }

  async sample(): Promise<void> {
    this.store.set("fps", this.metric());
  }
}
