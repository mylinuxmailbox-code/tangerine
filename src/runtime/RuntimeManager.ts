import type { RuntimeConfig } from "../config/schema.js";
import { TangerineError } from "../core/Errors.js";
import type { RuntimeAdapter } from "./RuntimeAdapter.js";

export type AdapterFactory = (config: Readonly<RuntimeConfig>) => RuntimeAdapter;

/** Registry + auto-detection. Core code only ever sees the RuntimeAdapter interface. */
export class RuntimeManager {
  private readonly factories = new Map<string, AdapterFactory>();

  register(id: string, factory: AdapterFactory): void {
    this.factories.set(id, factory);
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  async resolve(config: Readonly<RuntimeConfig>): Promise<RuntimeAdapter> {
    if (config.adapter !== "auto") {
      const f = this.factories.get(config.adapter);
      if (!f) {
        throw new TangerineError({ code: "RUNTIME_NOT_FOUND", subsystem: "runtime", message: `Unknown runtime adapter "${config.adapter}". Registered: ${this.ids().join(", ")}`, recoverable: false, hint: "Use runtime.adapter=auto or a registered id." });
      }
      return f(config);
    }
    for (const [, f] of this.factories) {
      const a = f(config);
      if (await a.detect()) return a;
    }
    throw new TangerineError({
      code: "RUNTIME_NOT_FOUND",
      subsystem: "runtime",
      message: "No runtime adapter detected a usable runtime (is runtime.executable set and executable?).",
      recoverable: false,
      hint: "Set runtime.executable in ~/.config/tangerine/config.json to your Android launch command.",
    });
  }

  async detectAll(config: Readonly<RuntimeConfig>): Promise<{ id: string; detected: boolean }[]> {
    const out: { id: string; detected: boolean }[] = [];
    for (const [id, f] of this.factories) out.push({ id, detected: await f(config).detect() });
    return out;
  }
}

import type { LinuxSystem } from "../system/Linux.js";
import { ExecChainRuntime } from "./AndroidRuntime.js";
import { PassthroughTranslation } from "./TranslationAdapter.js";

/** Registry with the built-in generic adapter. Additional adapters register themselves the same way. */
export function createDefaultRuntimeManager(sys: LinuxSystem): RuntimeManager {
  const rm = new RuntimeManager();
  rm.register("exec-chain", (cfg) => new ExecChainRuntime(cfg.executable, new PassthroughTranslation(), (n) => sys.which(n)));
  return rm;
}
