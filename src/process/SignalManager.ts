import type { Logger } from "../utils/Logger.js";
import { signalNumber } from "./ManagedProcess.js";

export type ShutdownHandler = (signal: NodeJS.Signals) => Promise<void> | void;

const HANDLED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/**
 * First signal => graceful shutdown (stop new work -> ask app to quit -> wait -> kill ->
 * rollback -> unmount -> destroy sandbox). A second signal while shutting down escalates:
 * emergency cleanup runs and the process exits immediately (spec §20).
 */
export class SignalManager {
  private installed = false;
  private count = 0;
  private readonly listeners = new Map<NodeJS.Signals, () => void>();

  constructor(
    private readonly logger: Logger,
    private readonly onShutdown: ShutdownHandler,
    private readonly onEmergency: (signal: NodeJS.Signals) => void,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    for (const sig of HANDLED) {
      const l = (): void => this.handle(sig);
      this.listeners.set(sig, l);
      process.on(sig, l);
    }
  }

  uninstall(): void {
    for (const [sig, l] of this.listeners) process.off(sig, l);
    this.listeners.clear();
    this.installed = false;
  }

  private handle(sig: NodeJS.Signals): void {
    this.count++;
    this.logger.warn("signal.received", { signal: sig, count: this.count });
    if (this.count === 1) {
      Promise.resolve(this.onShutdown(sig)).catch((e) => this.logger.error("shutdown.failed", { error: String(e) }));
    } else {
      this.logger.error("signal.escalated", { signal: sig });
      this.onEmergency(sig);
      process.exit(128 + (signalNumber(sig) ?? 15));
    }
  }
}
