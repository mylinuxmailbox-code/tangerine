import type { TangerineConfig } from "./schema.js";
import type { HardwareClass } from "../performance/HardwareProfile.js";

/**
 * Baseline defaults. Hardware-dependent values are chosen from the detected HardwareClass,
 * but are only *defaults*: config file / env / CLI always win (spec §34).
 *
 * Sampling intervals (spec §28): every sample is a small /proc or /sys read, but on a
 * 2-core machine each wake-up still competes with the workload, so the i3-6006U class
 * samples less often and relies on cached static data.
 */
export function buildDefaults(hw: HardwareClass): TangerineConfig {
  const slow = hw.id !== "standard";
  return {
    runtime: {
      adapter: "auto",
      args: [],
      env: {},
      passEnv: [],
      mounts: [],
      stopTimeoutMs: 8000,
      fpsFromStderr: false,
    },
    graphics: {
      backend: "auto",
      vsync: true,
      debug: false,
      shaderCache: true,
      glthread: false,
    },
    cpu: {
      affinity: { enabled: false, strategy: "none" },
      scheduler: "normal",
      rtPriority: 1,
      allowRealtime: false,
      nice: 0,
      background: [],
    },
    memory: {
      monitor: true,
      swapMonitoring: true,
      cacheManagement: false,
      highPercent: 0,
      // Hysteresis band (pages/s). 4 KiB pages: 200 pages/s ~= 0.8 MiB/s sustained swap traffic.
      swapInActivePagesPerSec: slow ? 200 : 500,
      swapInInactivePagesPerSec: slow ? 50 : 100,
    },
    sandbox: {
      enabled: true,
      backend: "auto",
      networkNamespace: true,
      pidNamespace: true,
      mountNamespace: true,
      allowDisplay: true,
      allowGpu: true,
      exposeHome: false,
      failIfDegraded: false,
    },
    network: { mode: "blocked", allow: [] },
    monitoring: {
      cpuIntervalMs: slow ? 1000 : 1000,
      memoryIntervalMs: slow ? 2000 : 1000,
      processIntervalMs: slow ? 2000 : 1000,
      gpuIntervalMs: slow ? 2000 : 1000,
      fpsIntervalMs: 1000,
    },
    performance: { profile: "balanced", disableCompositor: false, useSystemdScope: true },
    ui: { enabled: true, refreshMs: slow ? 500 : 250 },
    logging: { level: "info", toFile: true },
  };
}
