import { loadConfig, getConfig } from "../config/index.js";
import { initDb } from "../db/index.js";

let bootstrapped = false;

export function bootstrap() {
  if (bootstrapped) return;
  loadConfig();
  initDb();
  bootstrapped = true;
}

export function out(obj: unknown): never {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

export function fail(message: string, extra?: Record<string, unknown>): never {
  process.stderr.write(JSON.stringify({ error: message, ...extra }) + "\n");
  process.exit(1);
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export { getConfig };
