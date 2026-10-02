import type { PartialConfig } from "../config/schema.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";
import type { BenchmarkPlanStep } from "./BenchmarkRunner.js";
import { deepMerge } from "../utils/Validation.js";

export type ExperimentKind = "cpu" | "graphics" | "memory" | "compositor";

export interface Experiment {
  kind: ExperimentKind;
  description: string;
  steps: BenchmarkPlanStep[];
  skipped: string[];
}

/**
 * Controlled experiments (spec §37): each step changes ONE major variable relative to the
 * previous step, so a difference can be attributed (still only as a hypothesis).
 */
export function buildExperiment(kind: ExperimentKind, caps: HostCapabilities): Experiment {
  const skipped: string[] = [];
  const steps: BenchmarkPlanStep[] = [];
  const base: PartialConfig = {
    cpu: { affinity: { enabled: false, strategy: "none" }, nice: 0, scheduler: "normal" },
    memory: { highPercent: 0, cacheManagement: false },
    performance: { profile: "custom", disableCompositor: false },
  };
  const merge = (...o: PartialConfig[]): PartialConfig => deepMerge<PartialConfig>({}, ...o);
  switch (kind) {
    case "cpu": {
      const gfx: PartialConfig = { graphics: { backend: caps.opengl ? "opengl" : "auto" } };
      steps.push({ label: "baseline", overlay: merge(base, gfx) });
      steps.push({ label: gfx.graphics?.backend === "opengl" ? "opengl" : "auto-graphics", overlay: merge(base, gfx) });
      const dedicated: PartialConfig = { cpu: { affinity: { enabled: true, strategy: "dedicated" }, nice: 0, scheduler: "normal" } };
      steps.push({ label: "opengl+affinity", overlay: merge(base, gfx, dedicated) });
      if (caps.permissions.hasSysNice || caps.permissions.minNice < 0) {
        steps.push({ label: "opengl+affinity+priority", overlay: merge(base, gfx, { cpu: { affinity: { enabled: true, strategy: "dedicated" }, nice: -5, scheduler: "normal" } }) });
      } else skipped.push("priority step skipped: lowering nice needs CAP_SYS_NICE or RLIMIT_NICE (running unprivileged)");
      // the first two steps are identical on purpose: the pair measures run-to-run noise for this setup
      return { kind, description: "baseline -> graphics -> +affinity -> +priority (one variable at a time; steps 1 and 2 are identical to expose noise)", steps, skipped };
    }
    case "graphics": {
      if (caps.opengl) steps.push({ label: "opengl", overlay: merge(base, { graphics: { backend: "opengl" } }) });
      else skipped.push("opengl unavailable");
      if (caps.vulkan) steps.push({ label: "vulkan", overlay: merge(base, { graphics: { backend: "vulkan" } }) });
      else skipped.push("vulkan unavailable (hardware ICD not found)");
      if (caps.opengl) steps.push({ label: "opengl+glthread", overlay: merge(base, { graphics: { backend: "opengl", glthread: true } }) });
      return { kind, description: "OpenGL vs Vulkan (and mesa_glthread) with everything else fixed", steps, skipped };
    }
    case "memory": {
      steps.push({ label: "no-memory-cap", overlay: merge(base) });
      if (caps.systemdScope) {
        steps.push({ label: "memory.high-80%", overlay: merge(base, { memory: { highPercent: 80 }, performance: { useSystemdScope: true } }) });
        steps.push({ label: "memory.high-65%", overlay: merge(base, { memory: { highPercent: 65 }, performance: { useSystemdScope: true } }) });
      } else skipped.push("memory.high steps skipped: no usable systemd user scope / cgroup v2");
      return { kind, description: "cgroup memory.high soft cap: off vs 80% vs 65% of RAM", steps, skipped };
    }
    case "compositor": {
      steps.push({ label: "compositor-on", overlay: merge(base) });
      if (caps.marcoCompositor) steps.push({ label: "compositor-off", overlay: merge(base, { performance: { disableCompositor: true } }) });
      else skipped.push("Marco compositor toggle unavailable (not MATE/Marco or gsettings missing)");
      return { kind, description: "Marco compositing on vs off (restored after each run)", steps, skipped };
    }
  }
}
