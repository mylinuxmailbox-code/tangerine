import type { AffinityConfig } from "../config/schema.js";
import type { CpuSummary } from "./CpuManager.js";
import { formatCpuList } from "../system/Linux.js";

export interface AffinityPlan {
  applied: boolean;
  cpus: number[];
  strategy: AffinityConfig["strategy"];
  reason: string;
  warnings: string[];
  /** argv prefix: `taskset -c <list>`; empty when not applied. */
  wrapper: string[];
}

/**
 * Process-level CPU affinity via sched_setaffinity(2) (through `taskset`). Applied as a
 * launch wrapper so the whole process tree inherits it with no race and nothing on the host
 * needs restoring afterwards. No global isolation (isolcpus/cpuset) is touched (spec §10).
 *
 * Why it can help: keeps the workload's threads on warm caches and leaves other cores to
 * Xorg/Marco. Why it can hurt: on a 2-core/4-thread CPU the desktop and the workload share
 * every core anyway, and pinning removes the scheduler's ability to use idle threads.
 * Therefore strategies are no-ops on <=4 logical CPUs unless the user asks for "dedicated"
 * or "manual", and the reason is always recorded.
 */
export function planAffinity(cfg: AffinityConfig, cpu: CpuSummary): AffinityPlan {
  const none = (reason: string, warnings: string[] = []): AffinityPlan => ({ applied: false, cpus: [], strategy: cfg.strategy, reason, warnings, wrapper: [] });
  if (!cfg.enabled || cfg.strategy === "none") return none("affinity disabled");
  const warnings: string[] = [];
  const allowed = new Set(cpu.allowed);
  const usableGroups = cpu.groups.map((g) => g.filter((c) => allowed.has(c))).filter((g) => g.length);
  const allUsable = usableGroups.flat().sort((a, b) => a - b);
  const done = (cpus: number[], reason: string): AffinityPlan => {
    const sorted = [...new Set(cpus)].sort((a, b) => a - b);
    if (!sorted.length || sorted.length === allUsable.length) return none(`${reason} -> would use all allowed CPUs; not applied`, warnings);
    return { applied: true, cpus: sorted, strategy: cfg.strategy, reason, warnings, wrapper: ["taskset", "-c", formatCpuList(sorted)] };
  };

  switch (cfg.strategy) {
    case "manual": {
      const wanted = cfg.cpus ?? [];
      const ok = wanted.filter((c) => allowed.has(c));
      const bad = wanted.filter((c) => !allowed.has(c));
      if (bad.length) warnings.push(`CPUs ${bad.join(",")} are offline or outside this process's allowed set and were ignored`);
      if (!ok.length) return none("manual: no requested CPU is usable", warnings);
      return done(ok, `manual selection ${wanted.join(",")}`);
    }
    case "auto": {
      if (cpu.logical <= 4) return none(`auto: ${cpu.logical} logical CPUs (${cpu.physical} cores) - pinning not applied; the desktop needs these cores and the benefit is unproven`, warnings);
      const reserved = usableGroups[usableGroups.length - 1] ?? [];
      return done(usableGroups.slice(0, -1).flat(), `auto: reserve physical core {${reserved.join(",")}} for the desktop`);
    }
    case "dedicated": {
      if (cpu.logical > 4) {
        const reserved = usableGroups[usableGroups.length - 1] ?? [];
        return done(usableGroups.slice(0, -1).flat(), `dedicated: reserve physical core {${reserved.join(",")}} for the desktop`);
      }
      if (cpu.smt) {
        warnings.push("EXPERIMENTAL: one thread per physical core on a low-core CPU leaves SMT siblings for the desktop. Benchmark against no pinning.");
        return done(usableGroups.map((g) => g[0] as number), "dedicated: primary SMT thread of each physical core");
      }
      return none("dedicated: <=4 cores without SMT - nothing sensible to reserve", warnings);
    }
    default:
      return none("affinity disabled");
  }
}
