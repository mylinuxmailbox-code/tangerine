import type { ProcFs } from "../system/ProcFs.js";
import { ok } from "./Metric.js";
import type { MetricsStore } from "./MetricsStore.js";
import type { Sampler } from "./MonitorManager.js";

export interface MemoryUsage {
  totalKb: number;
  availableKb: number;
  /** total - available: what is genuinely in use (page cache that can be reclaimed is excluded). */
  usedKb: number;
  cachedKb: number;
  buffersKb: number;
  anonKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  swapUsedKb: number;
  /** Utilisation is NOT pressure (spec §13): 90% used with a big reclaimable cache is healthy. */
  utilizationPercent: number;
  /** Kernel PSI "some avg10" for memory, % of time at least one task stalled on memory. Undefined if PSI is off. */
  psiSomeAvg10?: number;
  psiFullAvg10?: number;
}

export class MemoryMonitor implements Sampler {
  readonly name = "memory";
  constructor(
    private readonly proc: ProcFs,
    private readonly store: MetricsStore,
  ) {}

  async sample(): Promise<void> {
    const [m, psi] = await Promise.all([this.proc.readMemInfo(), this.proc.readPsi("memory")]);
    const used = Math.max(0, m.totalKb - m.availableKb);
    this.store.series.memoryUsedMb.push(used / 1024);
    this.store.set(
      "memory",
      ok({
        totalKb: m.totalKb,
        availableKb: m.availableKb,
        usedKb: used,
        cachedKb: m.cachedKb,
        buffersKb: m.buffersKb,
        anonKb: m.anonPagesKb,
        swapTotalKb: m.swapTotalKb,
        swapFreeKb: m.swapFreeKb,
        swapUsedKb: Math.max(0, m.swapTotalKb - m.swapFreeKb),
        utilizationPercent: m.totalKb ? (used / m.totalKb) * 100 : 0,
        psiSomeAvg10: psi?.someAvg10,
        psiFullAvg10: psi?.fullAvg10,
      }),
    );
  }
}
