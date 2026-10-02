import type { ProcFs, VmStat } from "../system/ProcFs.js";
import { ok, unavailable } from "./Metric.js";
import type { MetricsStore } from "./MetricsStore.js";
import type { Sampler } from "./MonitorManager.js";
import { monotonicMs } from "../utils/Timing.js";

export interface SwapPressure {
  active: boolean;
  pagesInPerSecond: number;
  pagesOutPerSecond: number;
  /** Major page faults/s: file-backed or swapped-in pages that had to be read from disk. */
  majorFaultsPerSecond?: number;
}

export interface SwapThresholds {
  /** Enter "active" when pages/s (in+out) >= this for `enterSamples` consecutive samples. */
  activePagesPerSec: number;
  /** Leave "active" only when pages/s < this for `exitSamples` consecutive samples. Must be <= activePagesPerSec. */
  inactivePagesPerSec: number;
  enterSamples?: number;
  exitSamples?: number;
}

/**
 * Swap thrash detection (spec §14): based on pswpin/pswpout RATES, not on swap fill level.
 * A hysteresis band (separate enter/exit thresholds + consecutive-sample counts) prevents
 * the state flapping around the threshold.
 */
export class SwapPressureDetector {
  private active = false;
  private above = 0;
  private below = 0;
  private prev?: { vm: VmStat; t: number };

  constructor(private readonly th: SwapThresholds) {}

  /** Feed a vmstat sample taken at monotonic time `tMs`. Returns undefined for the very first sample. */
  update(vm: VmStat, tMs: number): SwapPressure | undefined {
    const prev = this.prev;
    this.prev = { vm, t: tMs };
    if (!prev) return undefined;
    const dt = (tMs - prev.t) / 1000;
    // Counters only increase; a decrease means reset/wrap - skip this interval instead of reporting nonsense.
    if (dt <= 0 || vm.pswpin < prev.vm.pswpin || vm.pswpout < prev.vm.pswpout) return undefined;
    const inRate = (vm.pswpin - prev.vm.pswpin) / dt;
    const outRate = (vm.pswpout - prev.vm.pswpout) / dt;
    const rate = inRate + outRate;
    const enter = this.th.enterSamples ?? 2;
    const exit = this.th.exitSamples ?? 3;
    if (rate >= this.th.activePagesPerSec) {
      this.above++;
      this.below = 0;
      if (!this.active && this.above >= enter) this.active = true;
    } else if (rate < this.th.inactivePagesPerSec) {
      this.below++;
      this.above = 0;
      if (this.active && this.below >= exit) this.active = false;
    } else {
      // inside the hysteresis band: hold the current state
      this.above = 0;
      this.below = 0;
    }
    const dMajor = vm.pgmajfault - prev.vm.pgmajfault;
    return { active: this.active, pagesInPerSecond: inRate, pagesOutPerSecond: outRate, majorFaultsPerSecond: dMajor >= 0 ? dMajor / dt : undefined };
  }
}

export class SwapMonitor implements Sampler {
  readonly name = "swap";
  constructor(
    private readonly proc: ProcFs,
    private readonly store: MetricsStore,
    private readonly detector: SwapPressureDetector,
  ) {}

  async sample(): Promise<void> {
    const vm = await this.proc.readVmStat();
    const p = this.detector.update(vm, monotonicMs());
    if (!p) return this.store.set("swap", unavailable("need two samples"));
    this.store.series.swapInPerSec.push(p.pagesInPerSecond);
    this.store.series.swapOutPerSec.push(p.pagesOutPerSecond);
    this.store.set("swap", ok(p));
  }
}
