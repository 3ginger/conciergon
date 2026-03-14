import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

/**
 * Validate Telegram bot token format and optionally verify via API.
 */
export async function validateTelegramToken(
  token: string
): Promise<{ valid: boolean; botName?: string; error?: string }> {
  // Format: digits:alphanumeric
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return { valid: false, error: "Invalid format. Expected: 123456:ABC-DEF..." };
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean; result?: { username: string } };
    if (data.ok && data.result) {
      return { valid: true, botName: data.result.username };
    }
    return { valid: false, error: "Token rejected by Telegram API" };
  } catch {
    // Network error — token format is valid, can't verify online
    return { valid: true, error: "Could not reach Telegram API to verify (format looks OK)" };
  }
}

/**
 * Validate projects directory exists and list found projects.
 */
export function validateProjectsDir(
  dir: string
): { valid: boolean; projects: string[]; error?: string } {
  const resolved = dir.replace(/^~/, homedir());

  if (!existsSync(resolved)) {
    return { valid: false, projects: [], error: `Directory does not exist: ${resolved}` };
  }

  try {
    const entries = readdirSync(resolved);
    const projects: string[] = [];
    for (const entry of entries) {
      try {
        const full = join(resolved, entry);
        if (statSync(full).isDirectory() && !entry.startsWith(".")) {
          projects.push(entry);
        }
      } catch {
        // skip unreadable entries
      }
    }
    return { valid: true, projects };
  } catch {
    return { valid: false, projects: [], error: `Cannot read directory: ${resolved}` };
  }
}

/**
 * Check if Claude Code CLI is available.
 */
export function validateClaudeCli(): { found: boolean; path?: string } {
  // Check common locations
  const candidates = [
    "claude",
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "bin", "claude"),
  ];

  for (const candidate of candidates) {
    try {
      const result = execFileSync(candidate, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (result) {
        return { found: true, path: candidate };
      }
    } catch {
      // not found at this path
    }
  }

  return { found: false };
}
