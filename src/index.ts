import { parseArgs, HELP } from "./cli/args.js";
import { cmdBenchmark, cmdConfig, cmdDoctor, cmdHelp, cmdInspect, cmdLogs, cmdRestart, cmdStart, cmdStatus, cmdStop } from "./cli/commands.js";
import { TangerineError, errMsg } from "./core/Errors.js";

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case "start": return await cmdStart(args);
      case "stop": return await cmdStop(args);
      case "restart": return await cmdRestart(args);
      case "status": return await cmdStatus(args);
      case "inspect": return await cmdInspect(args);
      case "doctor": return await cmdDoctor(args);
      case "benchmark": return await cmdBenchmark(args);
      case "config": return await cmdConfig(args);
      case "logs": return await cmdLogs(args);
      case "version": process.stdout.write("tangerine 0.1.0\n"); return 0;
      case "help": return cmdHelp();
    }
  } catch (e) {
    if (e instanceof TangerineError) {
      process.stderr.write(e.describe() + "\n");
      return e.code === "CONFIG_INVALID" ? 2 : 1;
    }
    process.stderr.write(`unexpected error: ${errMsg(e)}\n${HELP.split("\n")[0]}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`fatal: ${errMsg(e)}\n`);
    process.exitCode = 1;
  },
);
