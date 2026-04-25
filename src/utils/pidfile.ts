import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { createChildLogger } from "./logger.js";

const log = createChildLogger("instance-lock");

function getLockFile(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "no-token";
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return join(tmpdir(), `conciergon-${tokenHash}.lock`);
}

let releaseLock: (() => void) | null = null;

/** Acquire an OS-level exclusive lock tied to the bot token.
 *  Any other process using the same token will fail to start. */
export function acquirePidfile(): void {
  const lockFile = getLockFile();

  writeFileSync(lockFile, String(process.pid), { flag: "a" });

  try {
    const release = lockfile.lockSync(lockFile, { realpath: false, stale: 10000 });
    releaseLock = release;
    writeFileSync(lockFile, String(process.pid));
    log.info({ lockFile, pid: process.pid }, "Instance lock acquired");
  } catch (err) {
    log.fatal(
      { lockFile, err: (err as Error).message },
      "Another Conciergon instance is already running. " +
      "To restart: launchctl kickstart -k gui/$(id -u)/com.conciergon.bot",
    );
    process.exit(1);
  }
}

export function releasePidfile(): void {
  if (releaseLock) {
    try {
      releaseLock();
      log.info("Instance lock released");
    } catch (err) {
      log.warn({ err }, "Failed to release lock");
    }
    releaseLock = null;
  }
}
