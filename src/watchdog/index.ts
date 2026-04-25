import { getConfig } from "../config/index.js";
import { getIdleWorkers } from "../db/queries.js";
import type { Dispatcher } from "../dispatcher/index.js";
import { createChildLogger } from "../utils/logger.js";
import { captureException } from "../utils/sentry.js";

const log = createChildLogger("watchdog");

export class Watchdog {
  private dispatcher: Dispatcher;
  private intervalMs: number;
  private sessionTimeoutS: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(dispatcher: Dispatcher) {
    const config = getConfig();
    this.dispatcher = dispatcher;
    this.intervalMs = config.WATCHDOG_INTERVAL_MS;
    this.sessionTimeoutS = config.WORKER_SESSION_TIMEOUT_S;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    log.info(
      "Watchdog started (interval=%dms, session_timeout=%ds)",
      this.intervalMs,
      this.sessionTimeoutS
    );

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Watchdog stopped");
  }

  private async tick(): Promise<void> {
    try {
      const workers = getIdleWorkers(this.sessionTimeoutS);
      for (const worker of workers) {
        log.warn({ workerId: worker.id }, "Worker past session timeout, cleaning up");
        this.dispatcher.cleanupWorker(worker.id);
      }
    } catch (err) {
      log.error({ err }, "Watchdog tick error");
      captureException(err);
    }
  }
}
