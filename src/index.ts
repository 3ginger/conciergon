import { loadConfig } from "./config/index.js";
import { initDb, closeDb } from "./db/index.js";
import { scanAndRegisterProjects } from "./utils/project-registry.js";
import {
  processMessage,
  startConciergSession,
  stopConciergSession,
  pingConciergSession,
} from "./concierg/index.js";
import { Dispatcher } from "./dispatcher/index.js";
import { Scheduler } from "./scheduler/index.js";
import { Watchdog } from "./watchdog/index.js";
import {
  initTelegramBot,
  setMessageHandler,
  setEditHandler,
  setRestartHandler,
  sendMessage,
  sendLongMessage,
  sendQuestionMessage,
  sendDocument,
  sendPhoto,
  sendTypingAction,
  startBot,
  stopBot,
  getBot,
} from "./telegram/index.js";
import { HealthMonitor } from "./health/index.js";
import { startTokenRefreshLoop, stopTokenRefreshLoop } from "./utils/token-refresh.js";
import { createChildLogger } from "./utils/logger.js";
import { initSentry } from "./utils/sentry.js";
import { acquirePidfile, releasePidfile } from "./utils/pidfile.js";

const log = createChildLogger("main");

async function main() {
  acquirePidfile();

  log.info("Conciergon starting...");

  initSentry();
  const config = loadConfig();
  log.info("Config loaded");
  initDb();
  scanAndRegisterProjects();
  initTelegramBot();

  const dispatcher = new Dispatcher();

  // Wire Telegram functions into dispatcher (for workers to send messages directly)
  dispatcher.setTelegramFunctions({
    sendMessage: async (chatId, text, context) => {
      const ids = await sendLongMessage(chatId, text, { plain: true, context });
      return ids[0] ?? 0;
    },
    sendLongMessage: (chatId, text, context) => sendLongMessage(chatId, text, { context }),
    sendQuestionMessage,
    sendDocument,
  });

  // 6. Start token refresh loop (keeps OAuth token fresh)
  startTokenRefreshLoop();

  // 7. Start Concierg session (Claude Code SDK)
  await startConciergSession();

  // 8. Init Health Monitor
  const health = new HealthMonitor({
    getBot,
    stopBot,
    startBot,
    pingSession: pingConciergSession,
    restartSession: async () => {
      await stopConciergSession();
      await startConciergSession();
    },
    alertChatId: config.TELEGRAM_ALLOWED_USERS[0],
  });

  // Shared sendMessage wrapper for MCP tools (plain text, tagged as concierg)
  const sendPlainMessage = async (chatId: number, text: string) => {
    await sendMessage(chatId, text, { plain: true, context: { source: "concierg" } });
  };

  // Shared sendPhoto wrapper for MCP tools
  const sendPhotoWrapper = async (chatId: number, photoPath: string, caption?: string) => {
    await sendPhoto(chatId, photoPath, caption, { source: "concierg" });
  };

  // 9. Wire Telegram -> Concierg -> dispatch intents
  setMessageHandler(async (text, messageId, chatId, replyToMessageId, replyToText, images, messageRowId) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, replyToMessageId, replyToText, images, messageRowId, {
        sendMessage: sendPlainMessage,
        sendPhoto: sendPhotoWrapper,
        handleIntent: (intent) => dispatcher.handleIntent(intent),
      });
      health.trackClassify();
    } catch (err) {
      log.error({ err, text, messageId, chatId }, "Error in message handler");
      throw err;
    } finally {
      health.trackMessageEnd(messageId);
      clearInterval(typingInterval);
    }
  });

  setEditHandler(async (text, messageId, chatId, messageRowId) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, null, null, [], messageRowId, {
        sendMessage: sendPlainMessage,
        sendPhoto: sendPhotoWrapper,
        handleIntent: (intent) => dispatcher.handleIntent(intent),
      });
      health.trackClassify();
    } catch (err) {
      log.error({ err, text, messageId, chatId }, "Error in edit handler");
      throw err;
    } finally {
      health.trackMessageEnd(messageId);
      clearInterval(typingInterval);
    }
  });

  // Wire /restart command handler
  setRestartHandler(async () => {
    log.info("Performing graceful restart...");

    health.stop();
    scheduler.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

    releasePidfile();
    log.info("Exiting — launchd will restart.");
    process.exit(0);
  });

  // 11. Cleanup stale workers (workers are loaded from DB on demand)
  await dispatcher.cleanupStaleWorkers();

  // 12. Start Scheduler (loads enabled schedules from DB)
  const scheduler = new Scheduler(dispatcher);
  scheduler.start();

  // 13. Start Watchdog (only monitors idle workers now)
  const watchdog = new Watchdog(dispatcher);
  watchdog.start();

  // 13. Start Telegram bot
  await startBot();

  // 14. Start health monitor (after bot is polling)
  health.start();

  log.info("Conciergon is running!");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutting down (%s)...", signal);

    health.stop();
    scheduler.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

    releasePidfile();
    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
