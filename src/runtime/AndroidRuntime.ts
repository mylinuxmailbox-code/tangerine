import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { MountSpec } from "../config/schema.js";
import type { ChildManagedProcess } from "../process/ManagedProcess.js";
import { TangerineError } from "../core/Errors.js";
import { PassthroughTranslation, type TranslationAdapter } from "./TranslationAdapter.js";
import { validateRuntimeRequest, type RuntimeAdapter, type RuntimeCapabilities, type RuntimeContext, type RuntimeStartOptions } from "./RuntimeAdapter.js";

const SYSTEM_PREFIXES = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"];

/**
 * "exec-chain": the generic, user-defined Android x86_64 execution chain.
 * The configured executable may be anything that starts the Android workload (a launcher
 * script, a translation-layer front-end, a compatibility wrapper); an optional
 * TranslationAdapter rewrites the command. No Android implementation is hard-coded here -
 * additional adapters (container-based, etc.) implement RuntimeAdapter and register in RuntimeManager.
 */
export class ExecChainRuntime implements RuntimeAdapter {
  readonly id = "exec-chain";
  version?: string;
  private ctx?: RuntimeContext;
  private executable?: string;
  private proc?: ChildManagedProcess;
  private cleaned = false;

  constructor(
    private readonly configuredExecutable: string | undefined,
    private readonly translation: TranslationAdapter = new PassthroughTranslation(),
    private readonly resolveExecutable: (name: string) => string | undefined = () => undefined,
  ) {}

  private resolve(): string | undefined {
    const exe = this.configuredExecutable;
    if (!exe) return undefined;
    const path = exe.startsWith("/") ? exe : this.resolveExecutable(exe);
    if (!path) return undefined;
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return undefined;
    }
  }

  async detect(): Promise<boolean> {
    // Also caches the resolved path so planning/dry-run can read mounts without prepare() side effects.
    this.executable = this.resolve();
    return this.executable !== undefined && (await this.translation.detect());
  }

  async prepare(context: RuntimeContext): Promise<void> {
    this.ctx = context;
    this.executable = this.resolve();
    if (!this.executable) {
      throw new TangerineError({
        code: "RUNTIME_NOT_FOUND",
        subsystem: "runtime",
        message: `runtime.executable ${JSON.stringify(this.configuredExecutable)} was not found or is not executable`,
        recoverable: false,
        hint: "Set runtime.executable to your Android launch script/binary (see `tangerine config`).",
      });
    }
    await this.translation.initialize();
    await this.translation.configure({ options: {} });
    this.version = undefined;
  }

  getExecutable(): string | undefined {
    return this.executable;
  }

  async start(o: RuntimeStartOptions): Promise<ChildManagedProcess> {
    if (!this.executable || !this.ctx) throw new TangerineError({ code: "PROCESS_START_FAILED", subsystem: "runtime", message: "prepare() was not called", recoverable: false });
    validateRuntimeRequest({ ...o.request, executable: this.executable });
    const t = await this.translation.execute({ executable: this.executable, args: o.request.args, environment: o.env, workingDirectory: o.request.workingDirectory });
    const argv = [...o.wrapper, t.command, ...t.args];
    const [command, ...args] = argv;
    this.proc = await o.processManager.spawn({
      command: command as string,
      args,
      env: t.environment,
      cwd: o.request.workingDirectory ?? this.ctx.config.workingDirectory,
      timeoutMs: o.timeoutMs,
      graceMs: this.ctx.config.stopTimeoutMs,
      label: `runtime:${this.id}`,
    });
    return this.proc;
  }

  async stop(): Promise<void> {
    await this.proc?.terminate("SIGTERM", this.ctx?.config.stopTimeoutMs ?? 8000);
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.stop();
    await this.translation.shutdown();
  }

  getEnvironment(): Record<string, string> {
    return {};
  }

  /** The directory holding the executable must be visible inside the sandbox (read-only), unless it is a system path. */
  getMounts(): MountSpec[] {
    if (!this.executable || SYSTEM_PREFIXES.some((p) => this.executable?.startsWith(p))) return [];
    const dir = dirname(this.executable);
    return [{ source: dir, target: dir, kind: "bind", readOnly: true, purpose: "runtime executable directory" }];
  }

  getCapabilities(): RuntimeCapabilities {
    return { wrappable: true, emitsFrameStats: this.ctx?.config.fpsFromStderr ?? false, needsPrivileges: [] };
  }
}
