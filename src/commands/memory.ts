// `vantage memory`: the project memory injected into Claude Code.

import path from "node:path";
import { compileMemory, initMemory, addNote, memoryDir } from "../memory.ts";
import { log } from "./output.ts";

export async function cmdMemory(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const sub = argv[0];
  switch (sub) {
    case "init": {
      const { created, existing } = initMemory(cwd);
      log(`memory at ${path.relative(cwd, memoryDir(cwd))}/`);
      if (created.length) log(`created: ${created.join(", ")}`);
      if (existing.length) log(`kept: ${existing.join(", ")}`);
      return 0;
    }
    case "add": {
      const category = argv[1];
      const text = argv.slice(2).join(" ");
      if (!category || !text) {
        log('usage: vantage memory add <category> <text>   (e.g. decisions "chose Postgres")');
        return 1;
      }
      const p = addNote(cwd, category, text);
      log(`noted in ${path.relative(cwd, p)}`);
      return 0;
    }
    case "show":
    case undefined: {
      const memory = compileMemory(cwd);
      if (!memory) {
        log("no project memory yet — run `vantage memory init`");
        return 0;
      }
      process.stdout.write(memory + "\n");
      return 0;
    }
    default:
      log(`unknown memory command "${sub}" (init | add | show)`);
      return 1;
  }
}
