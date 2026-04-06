import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("pidfile");
const PIDFILE = join(process.cwd(), "conciergon.pid");

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquirePidfile(): void {
  if (existsSync(PIDFILE)) {
    const raw = readFileSync(PIDFILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!isNaN(pid) && isProcessRunning(pid) && pid !== process.pid) {
      log.fatal(
        { existingPid: pid, pidfile: PIDFILE },
        "Another Conciergon instance is already running (PID %d). Exiting.",
        pid,
      );
      process.exit(1);
    }
    log.warn("Stale pidfile found (PID %d no longer running), overwriting.", pid);
  }
  writeFileSync(PIDFILE, String(process.pid), "utf-8");
  log.info("Pidfile acquired (PID %d)", process.pid);
}

export function releasePidfile(): void {
  try {
    if (existsSync(PIDFILE)) {
      const raw = readFileSync(PIDFILE, "utf-8").trim();
      if (parseInt(raw, 10) === process.pid) {
        unlinkSync(PIDFILE);
        log.info("Pidfile released.");
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to remove pidfile");
  }
}
