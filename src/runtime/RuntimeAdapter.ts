import type { CpuConfig, GraphicsConfig, MountSpec, NetworkConfig, RuntimeConfig, SandboxConfig } from "../config/schema.js";
import type { GraphicsSelection } from "../performance/GraphicsManager.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { ProcessManager } from "../process/ProcessManager.js";
import type { ChildManagedProcess } from "../process/ManagedProcess.js";
import type { Logger } from "../utils/Logger.js";
import { TangerineError } from "../core/Errors.js";
import { ENV_KEY_RE, hasNul } from "../utils/Validation.js";

export type { MountSpec };

export interface RuntimeCapabilities {
  /** Can the launch be wrapped in taskset/nice/sandbox prefixes? False for runtimes that start a separate daemon/container. */
  wrappable: boolean;
  /** Does the runtime itself print frame statistics Tangerine can parse? */
  emitsFrameStats: boolean;
  /** Linux privileges the runtime needs, with the reason (spec §46). */
  needsPrivileges: string[];
}

/** Explicit request model (spec §55). */
export interface RuntimeRequest {
  executable: string;
  args: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  mounts?: MountSpec[];
  graphics?: GraphicsConfig;
  cpu?: CpuConfig;
  network?: NetworkConfig;
  sandbox?: SandboxConfig;
}

export interface RuntimeContext {
  config: Readonly<RuntimeConfig>;
  graphics: GraphicsSelection;
  sessionDir: string;
  sys: LinuxSystem;
  logger: Logger;
}

export interface RuntimeStartOptions {
  request: RuntimeRequest;
  /** Fully built, validated environment. */
  env: Record<string, string>;
  /** argv prefix produced by cgroup/affinity/scheduler/sandbox layers; empty if the adapter is not wrappable. */
  wrapper: string[];
  processManager: ProcessManager;
  timeoutMs?: number;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly version?: string;
  detect(): Promise<boolean>;
  prepare(context: RuntimeContext): Promise<void>;
  start(options: RuntimeStartOptions): Promise<ChildManagedProcess>;
  stop(): Promise<void>;
  cleanup(): Promise<void>;
  getEnvironment(): Record<string, string>;
  getMounts(): MountSpec[];
  getCapabilities(): RuntimeCapabilities;
  /** Executable to launch after preparation (resolved absolute path). */
  getExecutable(): string | undefined;
}

export function validateRuntimeRequest(r: RuntimeRequest): void {
  const bad = (m: string): never => {
    throw new TangerineError({ code: "RUNTIME_REQUEST_INVALID", subsystem: "runtime", message: m, recoverable: false, hint: "Check runtime.executable / runtime.args in your config." });
  };
  if (!r.executable || hasNul(r.executable)) bad("executable is empty or contains NUL");
  if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string" || hasNul(a))) bad("args must be NUL-free strings");
  if (r.workingDirectory !== undefined && !r.workingDirectory.startsWith("/")) bad("workingDirectory must be absolute");
  for (const [k, v] of Object.entries(r.environment ?? {})) {
    if (!ENV_KEY_RE.test(k) || hasNul(v)) bad(`invalid environment entry ${JSON.stringify(k)}`);
  }
}
