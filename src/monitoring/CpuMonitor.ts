import type { ProcFs, CpuStat } from "../system/ProcFs.js";
import { cpuUsagePercent } from "../system/ProcFs.js";
import type { SysFs } from "../system/SysFs.js";
import { ok, unavailable } from "./Metric.js";
import type { MetricsStore } from "./MetricsStore.js";
import type { Sampler } from "./MonitorManager.js";

export interface CpuUsage {
  totalPercent: number;
  perCpu: { id: number; percent: number; freqMhz?: number }[];
  /** Hottest thermal zone, deg C. */
  tempC?: number;
  /** Mean current/max frequency across CPUs, 0..1. A low ratio at high load hints at thermal/power throttling (hypothesis, not proof). */
  freqRatio?: number;
}

/**
 * /proc/stat deltas (cheap: one file read) + cpufreq + thermal. Frequency and temperature matter
 * on 15 W parts such as the i3-6006U, where sustained load can lower clocks.
 */
export class CpuMonitor implements Sampler {
  readonly name = "cpu";
  private prev?: CpuStat;
  constructor(
    private readonly proc: ProcFs,
    private readonly sysfs: SysFs,
    private readonly store: MetricsStore,
  ) {}

  async sample(): Promise<void> {
    const cur = await this.proc.readCpuStat();
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return this.store.set("cpu", unavailable("need two samples"));
    const total = cpuUsagePercent(prev.total, cur.total);
    if (total === undefined) return;
    const freqs = await this.sysfs.readCpuFrequenciesKhz();
    const topo = await this.sysfs.readCpuTopology();
    const perCpu: CpuUsage["perCpu"] = [];
    const ratios: number[] = [];
    for (const [id, t] of cur.perCpu) {
      const p = prev.perCpu.get(id);
      const pct = p ? cpuUsagePercent(p, t) : undefined;
      if (pct === undefined) continue;
      const f = freqs.get(id);
      perCpu.push({ id, percent: pct, freqMhz: f !== undefined ? Math.round(f / 1000) : undefined });
      const max = topo.cpus.find((c) => c.logicalId === id)?.maxFreqKhz;
      if (f !== undefined && max) ratios.push(f / max);
    }
    perCpu.sort((a, b) => a.id - b.id);
    const milli = await this.sysfs.readThermalMilliC();
    const mhz = perCpu.map((c) => c.freqMhz).filter((x): x is number => x !== undefined);
    if (mhz.length) this.store.series.cpuMhz.push(mhz.reduce((a, b) => a + b, 0) / mhz.length);
    this.store.series.cpuPercent.push(total);
    this.store.set(
      "cpu",
      ok({ totalPercent: total, perCpu, tempC: milli !== undefined ? milli / 1000 : undefined, freqRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : undefined }),
    );
  }
}
