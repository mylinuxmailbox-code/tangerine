import type { MemoryConfig } from "../config/schema.js";
import type { MemInfo, ProcFs } from "../system/ProcFs.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { MutationManager, SystemMutation } from "../core/MutationManager.js";
import { TangerineError } from "../core/Errors.js";

export interface MemoryPlan {
  totalMb: number;
  /** cgroup v2 memory.high in bytes, if a limit will be applied. */
  highBytes?: number;
  reason: string;
  warnings: string[];
  cacheDrop: boolean;
}

/**
 * memory.high (cgroup v2): above this threshold the kernel throttles the workload and
 * reclaims its pages instead of invoking the OOM killer. On an 8 GB machine this is meant
 * to keep the desktop's working set resident so the host does not enter swap thrash.
 * It can hurt: a workload that legitimately needs more than the cap is slowed (more
 * reclaim, possibly swap). Hence it is a percentage you can set to 0 and the swap-pressure
 * detector reports whether it is hurting. Requires cgroup v2 + a systemd user scope (no root).
 */
export function planMemory(cfg: MemoryConfig, mem: MemInfo, scopeAvailable: boolean): MemoryPlan {
  const totalMb = Math.round(mem.totalKb / 1024);
  const warnings: string[] = [];
  let highBytes: number | undefined;
  let reason = "memory limits disabled";
  if (cfg.highPercent > 0) {
    if (!scopeAvailable) {
      reason = "memory.high requested but no systemd user scope / cgroup v2 available; running without a memory cap";
      warnings.push(reason);
    } else {
      // Round down to a whole MiB to keep the systemd property human-readable and stable.
      highBytes = Math.floor((mem.totalKb * 1024 * cfg.highPercent) / 100 / 1048576) * 1048576;
      reason = `memory.high = ${cfg.highPercent}% of ${totalMb} MB = ${Math.round(highBytes / 1048576)} MB (soft cap, not an OOM limit)`;
    }
  }
  return { totalMb, highBytes, reason, warnings, cacheDrop: cfg.cacheManagement };
}

export interface CacheDropOutcome {
  beforeAvailableKb: number;
  afterAvailableKb: number;
  beforeCachedKb: number;
  afterCachedKb: number;
}

/**
 * Opt-in, one-shot, pre-launch only. `sync` then write "1" (page cache only; "3" would
 * also drop dentries/inodes which hurts more). Not reversible: the cache simply refills.
 * Requires root (writes /proc/sys/vm/drop_caches). Outcome is recorded for benchmarking.
 */
export function createDropCachesMutation(sys: LinuxSystem, proc: ProcFs, mm: MutationManager, onOutcome: (o: CacheDropOutcome) => void): SystemMutation {
  let before: MemInfo | undefined;
  return mm.create(
    "drop page cache once before launch (opt-in)",
    async () => {
      if (sys.uid() !== 0) {
        throw new TangerineError({ code: "MUTATION_FAILED", subsystem: "memory", message: "drop_caches needs root", recoverable: true, fallback: "skipped", hint: "Run with sudo or set memory.cacheManagement=false." });
      }
      before = await proc.readMemInfo();
      await sys.execute("sync", [], { timeoutMs: 30_000 });
      await sys.writeFile("/proc/sys/vm/drop_caches", "1\n");
      const after = await proc.readMemInfo();
      onOutcome({ beforeAvailableKb: before.availableKb, afterAvailableKb: after.availableKb, beforeCachedKb: before.cachedKb, afterCachedKb: after.cachedKb });
    },
    async () => undefined,
    { irreversible: true },
  );
}
