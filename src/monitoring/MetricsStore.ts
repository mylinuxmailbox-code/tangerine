import type { Metric } from "./Metric.js";
import type { CpuUsage } from "./CpuMonitor.js";
import type { MemoryUsage } from "./MemoryMonitor.js";
import type { SwapPressure } from "./SwapMonitor.js";
import type { ProcessUsage } from "./ProcessMonitor.js";
import type { GpuUsage } from "./GpuMonitor.js";
import type { FpsStats } from "./FpsMonitor.js";
import { unavailable } from "./Metric.js";

export interface MetricsSnapshot {
  cpu: Metric<CpuUsage>;
  memory: Metric<MemoryUsage>;
  swap: Metric<SwapPressure>;
  process: Metric<ProcessUsage>;
  gpu: Metric<GpuUsage>;
  fps: Metric<FpsStats>;
  version: number;
}

export type MetricKey = Exclude<keyof MetricsSnapshot, "version">;

/** Fixed-size numeric ring for benchmark aggregation; O(1) memory regardless of run length. */
export class Series {
  private readonly buf: number[] = [];
  constructor(private readonly cap = 7200) {}
  push(n: number): void {
    if (!Number.isFinite(n)) return;
    this.buf.push(n);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  clear(): void {
    this.buf.length = 0;
  }
  get length(): number {
    return this.buf.length;
  }
  mean(): number | undefined {
    return this.buf.length ? this.buf.reduce((a, b) => a + b, 0) / this.buf.length : undefined;
  }
  max(): number | undefined {
    return this.buf.length ? Math.max(...this.buf) : undefined;
  }
  values(): readonly number[] {
    return this.buf;
  }
}

/**
 * Central metrics store (spec §30). Monitors write; the UI and benchmark read.
 * Writers never trigger rendering directly: the UI polls `version` on its own throttled timer,
 * so a 1 kHz writer cannot cause 1 kHz React renders.
 */
export class MetricsStore {
  private snap: MetricsSnapshot;
  readonly series = {
    cpuPercent: new Series(),
    memoryUsedMb: new Series(),
    swapInPerSec: new Series(),
    swapOutPerSec: new Series(),
    processRssMb: new Series(),
    cpuMhz: new Series(),
  };

  constructor() {
    const none = (r: string): Metric<never> => unavailable(r);
    this.snap = {
      cpu: none("not sampled yet"),
      memory: none("not sampled yet"),
      swap: none("not sampled yet"),
      process: none("not sampled yet"),
      gpu: none("not sampled yet"),
      fps: none("No supported frame timing source"),
      version: 0,
    };
  }

  set<K extends MetricKey>(key: K, metric: MetricsSnapshot[K]): void {
    this.snap = { ...this.snap, [key]: metric, version: this.snap.version + 1 };
  }

  get snapshot(): MetricsSnapshot {
    return this.snap;
  }
  get version(): number {
    return this.snap.version;
  }
}
