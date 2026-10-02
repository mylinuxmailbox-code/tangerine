import type { ProcFs } from "../system/ProcFs.js";
import { snapshotTree } from "../process/ProcessTree.js";
import { ok, unavailable } from "./Metric.js";
import type { MetricsStore } from "./MetricsStore.js";
import type { Sampler } from "./MonitorManager.js";
import { monotonicMs } from "../utils/Timing.js";

export interface ProcessUsage {
  pid: number;
  /** Every live PID in the workload's tree (the root PID is not assumed to be everything). */
  treePids: number[];
  rssKb: number;
  vmSizeKb: number;
  anonKb: number;
  swapKb: number;
  threads: number;
  /** % of ONE CPU (can exceed 100 on multi-core), from utime+stime deltas. */
  cpuPercent?: number;
}

/** USER_HZ is fixed at 100 for the Linux userspace ABI on x86_64. */
const CLK_TCK = 100;

export class ProcessMonitor implements Sampler {
  readonly name = "process";
  private prev?: { ticks: number; t: number; pids: Set<number> };
  constructor(
    private readonly proc: ProcFs,
    private readonly store: MetricsStore,
    private readonly getPid: () => number | undefined,
  ) {}

  async sample(): Promise<void> {
    const pid = this.getPid();
    if (pid === undefined) return this.store.set("process", unavailable("no workload running"));
    const pids = await snapshotTree(this.proc, pid);
    let rss = 0, vsz = 0, anon = 0, swap = 0, threads = 0, ticks = 0;
    let found = 0;
    for (const p of pids) {
      try {
        const s = await this.proc.readProcessStatus(p);
        rss += s.vmRssKb ?? 0;
        vsz += s.vmSizeKb ?? 0;
        anon += s.rssAnonKb ?? 0;
        swap += s.vmSwapKb ?? 0;
        threads += s.threads ?? 0;
        found++;
        const st = await this.proc.readProcessStat(p);
        if (st) ticks += st.utime + st.stime;
      } catch {
        /* exited between listing and reading */
      }
    }
    if (!found) return this.store.set("process", unavailable("workload exited"));
    const now = monotonicMs();
    const set = new Set(pids);
    let cpuPercent: number | undefined;
    // Only compare when the PID set is unchanged: otherwise exited children's ticks vanish and the delta lies.
    if (this.prev && this.prev.pids.size === set.size && [...set].every((x) => this.prev?.pids.has(x))) {
      const dt = (now - this.prev.t) / 1000;
      if (dt > 0 && ticks >= this.prev.ticks) cpuPercent = ((ticks - this.prev.ticks) / CLK_TCK / dt) * 100;
    }
    this.prev = { ticks, t: now, pids: set };
    this.store.series.processRssMb.push(rss / 1024);
    this.store.set("process", ok({ pid, treePids: pids, rssKb: rss, vmSizeKb: vsz, anonKb: anon, swapKb: swap, threads, cpuPercent }));
  }
}
