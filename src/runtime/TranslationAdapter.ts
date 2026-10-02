/**
 * Replaceable translation seam (spec §54). A translation adapter converts Tangerine's generic
 * request into whatever an implementation needs (e.g. wrapping an x86_64 Android binary in a
 * user-chosen translation layer or compatibility launcher). The process manager never sees
 * implementation details: it only receives the final {command,args,env}.
 */
export interface TranslationConfig {
  /** Free-form, adapter-specific options (never interpreted by core). */
  options: Record<string, string>;
}

export interface TranslationRequest {
  executable: string;
  args: string[];
  environment: Record<string, string>;
  workingDirectory?: string;
}

export interface TranslationResult {
  command: string;
  args: string[];
  environment: Record<string, string>;
  notes: string[];
}

export interface TranslationAdapter {
  readonly id: string;
  detect(): Promise<boolean>;
  initialize(): Promise<void>;
  configure(config: TranslationConfig): Promise<void>;
  execute(request: TranslationRequest): Promise<TranslationResult>;
  shutdown(): Promise<void>;
}

/** Native/identity translation: the target is already runnable on the host (or inside the user's own chain). */
export class PassthroughTranslation implements TranslationAdapter {
  readonly id = "passthrough";
  async detect(): Promise<boolean> {
    return true;
  }
  async initialize(): Promise<void> {}
  async configure(_config: TranslationConfig): Promise<void> {}
  async execute(request: TranslationRequest): Promise<TranslationResult> {
    return { command: request.executable, args: [...request.args], environment: { ...request.environment }, notes: [] };
  }
  async shutdown(): Promise<void> {}
}

/**
 * User-provided execution chain: `prefix... executable args...`, e.g. a user's own launcher
 * script. Nothing about any specific Android runtime is built into Tangerine.
 */
export class PrefixChainTranslation implements TranslationAdapter {
  readonly id = "prefix-chain";
  constructor(private readonly prefix: string[]) {}
  async detect(): Promise<boolean> {
    return this.prefix.length > 0;
  }
  async initialize(): Promise<void> {}
  async configure(_c: TranslationConfig): Promise<void> {}
  async execute(request: TranslationRequest): Promise<TranslationResult> {
    const [command, ...rest] = [...this.prefix, request.executable];
    return { command: command as string, args: [...rest, ...request.args], environment: { ...request.environment }, notes: [`chain: ${this.prefix.join(" ")}`] };
  }
  async shutdown(): Promise<void> {}
}
