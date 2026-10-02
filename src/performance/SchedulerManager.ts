import type { CpuConfig } from "../config/schema.js";
import type { PermissionInfo } from "../system/Permissions.js";

export interface SchedulerPlan {
  policy: "normal" | "rr";
  requestedNice: number;
  nice: number;
  rtPriority?: number;
  warnings: string[];
  /** argv prefix, e.g. ["nice","-n","5"] or ["chrt","-r","1"]. */
  wrapper: string[];
}

/**
 * Scheduler configuration (spec §11). Applied via exec wrappers (`nice`, `chrt`) so it is
 * inherited by the entire tree and dies with it - nothing on the host to roll back.
 *
 *  - Unprivileged users may only RAISE their nice value (lower priority) unless
 *    CAP_SYS_NICE or RLIMIT_NICE allows otherwise (Mint default: RLIMIT_NICE=0), so a
 *    negative request is clamped to what is permitted and the downgrade is reported.
 *  - SCHED_RR is NEVER implicit: it needs cpu.scheduler="rr" AND cpu.allowRealtime=true AND a
 *    permission check. On a 2-core host a spinning SCHED_RR task can starve Xorg; the kernel's
 *    RT throttling (sched_rt_runtime_us, default 95%) is the only remaining safety net.
 */
export function planScheduler(cfg: CpuConfig, perms: PermissionInfo, currentNice: number, hasChrt: boolean): SchedulerPlan {
  const warnings: string[] = [];
  let policy: "normal" | "rr" = "normal";
  let rtPriority: number | undefined;

  if (cfg.scheduler === "rr") {
    const rtOk = cfg.allowRealtime && hasChrt && (perms.hasSysNice || (perms.rtprioLimit ?? 0) >= cfg.rtPriority);
    if (rtOk) {
      policy = "rr";
      rtPriority = cfg.rtPriority;
      warnings.push(`SCHED_RR priority ${cfg.rtPriority} enabled: a CPU-bound workload can starve the desktop. Rolling back = stopping the workload.`);
    } else {
      const why = !cfg.allowRealtime ? "cpu.allowRealtime is false" : !hasChrt ? "chrt is not installed" : "no CAP_SYS_NICE / RLIMIT_RTPRIO";
      warnings.push(`SCHED_RR requested but unavailable (${why}); using normal scheduling [SCHEDULER_PERMISSION_DENIED]`);
    }
  }

  let nice = cfg.nice;
  if (policy === "normal") {
    // Lowest nice we may request: anything with CAP_SYS_NICE, else bounded by RLIMIT_NICE (never above our current value).
    const floor = perms.hasSysNice ? -20 : Math.min(currentNice, perms.minNice);
    if (nice < floor) {
      nice = floor;
      warnings.push(`nice ${cfg.nice} requires CAP_SYS_NICE or RLIMIT_NICE; clamped to ${floor} [SCHEDULER_PERMISSION_DENIED]`);
    }
  }
  const wrapper: string[] = policy === "rr" ? ["chrt", "-r", String(rtPriority)] : nice !== 0 ? ["nice", "-n", String(nice)] : [];
  return { policy, requestedNice: cfg.nice, nice: policy === "rr" ? currentNice : nice, rtPriority, warnings, wrapper };
}
