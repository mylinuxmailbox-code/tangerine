import type { SysFs, GpuDevice } from "../system/SysFs.js";
import { ok, unavailable } from "./Metric.js";
import type { MetricsStore } from "./MetricsStore.js";
import type { Sampler } from "./MonitorManager.js";

export interface GpuUsage {
  devices: GpuDevice[];
  /** Honest note about what could NOT be measured (e.g. utilisation needs privileged perf/debugfs). */
  limitations: string[];
}

/**
 * Unprivileged GPU telemetry from /sys/class/drm: i915 clock frequencies (cur/act/max/boost).
 * GPU *utilisation* is not exposed without privileges (intel_gpu_top needs CAP_PERFMON or root),
 * so it is reported as unavailable instead of being guessed (spec §17).
 */
export class GpuMonitor implements Sampler {
  readonly name = "gpu";
  constructor(
    private readonly sysfs: SysFs,
    private readonly store: MetricsStore,
  ) {}

  async sample(): Promise<void> {
    const info = await this.sysfs.readGpuInfo();
    const withData = info.devices.filter((d) => d.curFreqMhz !== undefined || d.actFreqMhz !== undefined);
    if (!info.devices.length) return this.store.set("gpu", unavailable("no DRM devices in /sys/class/drm"));
    const limitations = ["GPU utilisation unavailable without root/CAP_PERFMON (intel_gpu_top)"];
    if (!info.debugfsReadable) limitations.push("debugfs not mounted/readable");
    if (!withData.length) limitations.push("no frequency counters exposed by this driver");
    this.store.set("gpu", ok({ devices: info.devices, limitations }));
  }
}
