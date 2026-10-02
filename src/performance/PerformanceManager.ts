import type { TangerineConfig } from "../config/schema.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";
import type { MemInfo, ProcFs } from "../system/ProcFs.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { MutationManager, SystemMutation } from "../core/MutationManager.js";
import { summarizeCpu, type CpuSummary } from "./CpuManager.js";
import { planAffinity, type AffinityPlan } from "./AffinityManager.js";
import { planScheduler, type SchedulerPlan } from "./SchedulerManager.js";
import { planMemory, createDropCachesMutation, type MemoryPlan, type CacheDropOutcome } from "./MemoryManager.js";
import { selectGraphics, type GraphicsSelection, type SelectOptions } from "./GraphicsManager.js";
import { createCompositorMutation } from "./CompositorManager.js";
import { resolveRules, buildBackgroundMutations, type ResolvedRule } from "./BackgroundProcessManager.js";

export interface PerformancePlan {
  profile: string;
  cpu: CpuSummary;
  affinity: AffinityPlan;
  scheduler: SchedulerPlan;
  memory: MemoryPlan;
  graphics: GraphicsSelection;
  compositor: { disable: boolean; available: boolean };
  background: ResolvedRule[];
  warnings: string[];
}

/** Pure planning: nothing here touches the host. Mutations are created from a plan separately. */
export class PerformanceManager {
  constructor(
    private readonly sys: LinuxSystem,
    private readonly proc: ProcFs,
  ) {}

  async plan(cfg: TangerineConfig, caps: HostCapabilities, mem: MemInfo, selfPids: Set<number>, gfxOpts: SelectOptions): Promise<PerformancePlan> {
    const cpu = await summarizeCpu(caps.topology, this.proc);
    const affinity = caps.cpuAffinity ? planAffinity(cfg.cpu.affinity, cpu) : planAffinity({ ...cfg.cpu.affinity, enabled: false }, cpu);
    if (!caps.cpuAffinity && cfg.cpu.affinity.enabled && cfg.cpu.affinity.strategy !== "none") affinity.warnings.push("CPU affinity unavailable (taskset missing or failing) [AFFINITY_FAILED]; continuing without pinning");
    const scheduler = planScheduler(cfg.cpu, caps.permissions, this.sys.getPriority(0), !!caps.helpers["chrt"]);
    const scopeOk = caps.systemdScope && cfg.performance.useSystemdScope;
    const memory = planMemory(cfg.memory, mem, scopeOk);
    const graphics = selectGraphics(cfg.graphics, caps.graphics, gfxOpts);
    const background = await resolveRules(cfg.cpu.background, this.proc, selfPids);
    const warnings = [...affinity.warnings, ...scheduler.warnings, ...memory.warnings, ...graphics.notes];
    if (cfg.performance.disableCompositor && !caps.marcoCompositor) warnings.push("disableCompositor requested but Marco gsettings schema not available; skipped");
    for (const r of background) for (const x of r.refused) warnings.push(`background rule refused for ${x.name}(${x.pid}): ${x.why}`);
    return {
      profile: cfg.performance.profile,
      cpu,
      affinity,
      scheduler,
      memory,
      graphics,
      compositor: { disable: cfg.performance.disableCompositor && caps.marcoCompositor, available: caps.marcoCompositor },
      background,
      warnings,
    };
  }

  /** Host mutations implied by a plan (everything else is applied via launch wrappers and leaves no host state). */
  async mutations(plan: PerformancePlan, mm: MutationManager, onCache: (o: CacheDropOutcome) => void): Promise<SystemMutation[]> {
    const out: SystemMutation[] = [];
    if (plan.memory.cacheDrop) out.push(createDropCachesMutation(this.sys, this.proc, mm, onCache));
    if (plan.compositor.disable) out.push(createCompositorMutation(this.sys, this.proc, mm));
    out.push(...(await buildBackgroundMutations(plan.background, this.sys, this.proc, mm)));
    return out;
  }
}
