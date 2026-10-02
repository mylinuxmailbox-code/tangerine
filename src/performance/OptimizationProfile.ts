import type { PartialConfig, PerformanceProfile } from "../config/schema.js";
import type { HardwareClass } from "./HardwareProfile.js";

/**
 * Profiles are plain, inspectable config overlays (spec §18: no hidden changes).
 * `describeProfile` returns the exact list of changes so `--dry-run` and the docs can print it.
 *
 * Nothing here claims a speed-up: each knob is an *experiment* to be validated with
 * `tangerine benchmark --experiment`.
 */
export interface ProfileDefinition {
  name: PerformanceProfile;
  summary: string;
  overlay: PartialConfig;
}

export function profileDefinition(name: PerformanceProfile, hw: HardwareClass): ProfileDefinition {
  const lowCore = hw.logicalCpus <= 4;
  switch (name) {
    case "safe":
      return {
        name,
        summary: "Minimal host changes: no pinning, no priority change, no cgroup limits.",
        overlay: {
          cpu: { affinity: { enabled: false, strategy: "none" }, nice: 0, scheduler: "normal" },
          memory: { highPercent: 0 },
          performance: { disableCompositor: false, useSystemdScope: false },
          graphics: { glthread: false, shaderCache: true },
        },
      };
    case "balanced":
      return {
        name,
        summary: lowCore
          ? "Soft memory cap (cgroup memory.high) and persistent shader cache. No pinning on <=4 logical CPUs (effect unproven; the desktop needs those cores)."
          : "Reserve one physical core for the desktop, soft memory cap, persistent shader cache.",
        overlay: {
          cpu: { affinity: { enabled: !lowCore, strategy: lowCore ? "none" : "auto" }, nice: 0, scheduler: "normal" },
          memory: { highPercent: 80 },
          performance: { disableCompositor: false, useSystemdScope: true },
          graphics: { glthread: false, shaderCache: true },
        },
      };
    case "performance":
      return {
        name,
        summary: lowCore
          ? "EXPERIMENTAL on low-core hosts: one thread per physical core (SMT siblings left to the desktop), nice -5 if permitted, tighter memory cap. Benchmark vs. balanced."
          : "Reserve one physical core for the desktop, nice -5 if permitted, tighter memory cap.",
        overlay: {
          cpu: { affinity: { enabled: true, strategy: "dedicated" }, nice: -5, scheduler: "normal" },
          memory: { highPercent: 85 },
          performance: { disableCompositor: false, useSystemdScope: true },
          graphics: { glthread: false, shaderCache: true },
        },
      };
    case "custom":
      return { name, summary: "No overlay: only defaults, config file, environment and CLI flags apply.", overlay: {} };
  }
}

export function describeProfile(def: ProfileDefinition): string[] {
  const lines: string[] = [`${def.name}: ${def.summary}`];
  const walk = (o: unknown, path: string): void => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    } else lines.push(`  ${path} = ${JSON.stringify(o)}`);
  };
  walk(def.overlay, "");
  return lines;
}
