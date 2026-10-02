export type GraphicsBackend = "auto" | "opengl" | "vulkan";
export type SchedulerPolicy = "normal" | "rr";
export type NetworkMode = "blocked" | "restricted" | "unrestricted";
export type PerformanceProfile = "safe" | "balanced" | "performance" | "custom";
export type AffinityStrategy = "manual" | "auto" | "dedicated" | "none";
export type SandboxBackend = "auto" | "bwrap" | "unshare" | "none";

export interface MountSpec {
  /** Absolute host path (ignored for tmpfs/proc/dev). */
  source?: string;
  /** Absolute path inside the sandbox. */
  target: string;
  kind: "bind" | "tmpfs" | "proc" | "dev";
  readOnly: boolean;
  /** Skip silently if the source does not exist (e.g. optional GPU nodes). */
  optional?: boolean;
  /** Pass device nodes through (bwrap --dev-bind). Only for /dev/dri style paths. */
  device?: boolean;
  /** Why this path is exposed; required for audit (spec §22, §46). */
  purpose: string;
}

export interface AffinityConfig {
  enabled: boolean;
  cpus?: number[];
  strategy: AffinityStrategy;
}

export interface BackgroundProcessRule {
  match: { pid: number } | { name: string };
  action: "lower-priority" | "pause" | "terminate";
  /** For lower-priority: nice value to apply (default 10). */
  nice?: number;
}

export interface RuntimeConfig {
  /** "auto" probes all registered adapters; otherwise an adapter id such as "exec-chain". */
  adapter: string;
  executable?: string;
  args: string[];
  workingDirectory?: string;
  env: Record<string, string>;
  /** Names of host env vars to forward (in addition to the safe base set). */
  passEnv: string[];
  mounts: MountSpec[];
  /** Grace period after SIGTERM before SIGKILL. */
  stopTimeoutMs: number;
  /** Set when the workload prints frame statistics to stderr in a parseable way. */
  fpsFromStderr: boolean;
}

export interface GraphicsConfig {
  backend: GraphicsBackend;
  vsync: boolean;
  frameLimit?: number;
  debug: boolean;
  extraEnvironment?: Record<string, string>;
  /** Persist the Mesa on-disk shader cache outside the sandbox (reduces shader-compile stutter; unverified per workload). */
  shaderCache: boolean;
  /** Mesa `mesa_glthread`. Can help CPU-bound GL drivers and hurt others: opt-in. */
  glthread: boolean;
}

export interface CpuConfig {
  affinity: AffinityConfig;
  scheduler: SchedulerPolicy;
  /** SCHED_RR priority 1..99; used only when scheduler === "rr" AND allowRealtime. */
  rtPriority: number;
  /** Explicit consent flag for real-time scheduling (spec §11). */
  allowRealtime: boolean;
  nice: number;
  background: BackgroundProcessRule[];
}

export interface MemoryConfig {
  monitor: boolean;
  swapMonitoring: boolean;
  /** Opt-in one-shot page-cache drop BEFORE launch. Needs root. Never repeated. */
  cacheManagement: boolean;
  /**
   * cgroup v2 memory.high as a % of physical RAM (0 = off). memory.high throttles the
   * workload via reclaim instead of OOM-killing it, which protects the desktop on 8 GB hosts.
   */
  highPercent: number;
  swapInActivePagesPerSec: number;
  swapInInactivePagesPerSec: number;
}

export interface SandboxConfig {
  enabled: boolean;
  backend: SandboxBackend;
  networkNamespace: boolean;
  pidNamespace: boolean;
  mountNamespace: boolean;
  /** Bind the user's X11/Wayland sockets and GPU nodes so graphical apps can render. */
  allowDisplay: boolean;
  allowGpu: boolean;
  /** Allow sharing $HOME. Off by default: never expose the full home directory. */
  exposeHome: boolean;
  /** Refuse to start if the requested isolation level cannot be enforced. */
  failIfDegraded: boolean;
}

export interface NetworkAllowRule {
  host?: string;
  cidr?: string;
  port?: number;
  protocol?: "tcp" | "udp";
}

export interface NetworkConfig {
  mode: NetworkMode;
  allow: NetworkAllowRule[];
}

export interface MonitoringConfig {
  cpuIntervalMs: number;
  memoryIntervalMs: number;
  processIntervalMs: number;
  gpuIntervalMs: number;
  fpsIntervalMs: number;
}

export interface PerformanceConfig {
  profile: PerformanceProfile;
  /**
   * MATE/Marco only. Temporarily turns the compositing manager off via gsettings and
   * restores the original value afterwards. Off by default: measure before enabling.
   */
  disableCompositor: boolean;
  /** Use a transient systemd user scope to apply cgroup limits without root. */
  useSystemdScope: boolean;
}

export interface UiConfig {
  enabled: boolean;
  /** React render throttle, independent of sampling. */
  refreshMs: number;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  toFile: boolean;
}

export interface TangerineConfig {
  runtime: RuntimeConfig;
  graphics: GraphicsConfig;
  cpu: CpuConfig;
  memory: MemoryConfig;
  sandbox: SandboxConfig;
  network: NetworkConfig;
  monitoring: MonitoringConfig;
  performance: PerformanceConfig;
  ui: UiConfig;
  logging: LoggingConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PartialConfig = DeepPartial<TangerineConfig>;
