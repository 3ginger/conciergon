import { spawn } from "node:child_process";
import { loadConfig } from "./config/index.js";
import { initDb, closeDb } from "./db/index.js";
import { scanAndRegisterProjects } from "./utils/project-registry.js";
import {
  processMessage,
  startConciergSession,
  stopConciergSession,
  pingConciergSession,
} from "./concierg/index.js";
import { Dispatcher, getWorkerIdByTelegramMessage } from "./dispatcher/index.js";
import { setPoolInfoGetter } from "./concierg/mcp-tools.js";
import { Watchdog } from "./watchdog/index.js";
import {
  initTelegramBot,
  setMessageHandler,
  setEditHandler,
  setCallbackQueryHandler,
  setRestartHandler,
  sendMessage,
  sendLongMessage,
  sendQuestionMessage,
  sendPhoto,
  sendTypingAction,
  startBot,
  stopBot,
  getBot,
  resolveOptionLabel,
  clearQuestionOptions,
} from "./telegram/index.js";
import { HealthMonitor } from "./health/index.js";
import { startTokenRefreshLoop, stopTokenRefreshLoop } from "./utils/token-refresh.js";
import { createChildLogger } from "./utils/logger.js";
import { initSentry } from "./utils/sentry.js";

const log = createChildLogger("main");

async function main() {
  log.info("Conciergon starting...");

  // 0. Init Sentry (before anything else)
  initSentry();

  // 1. Load config
  const config = loadConfig();
  log.info("Config loaded");

  // 2. Init DB
  initDb();

  // 3. Scan and register projects
  scanAndRegisterProjects();

  // 4. Init Telegram bot
  initTelegramBot();

  // 5. Init Dispatcher
  const dispatcher = new Dispatcher();

  // Wire pool info getter so concierg's get_system_state shows pool/phase info
  setPoolInfoGetter((workerId) => {
    const session = dispatcher.getPool().get(workerId);
    if (!session) return null;
    return {
      poolStatus: session.isCold() ? 'cold' : 'warm',
      phase: session.phase,
      hasPendingPlan: session.hasPendingPlan(),
    };
  });

  // Wire Telegram functions into dispatcher (for workers to send messages directly)
  dispatcher.setTelegramFunctions({
    sendMessage: async (chatId, text) => {
      const ids = await sendLongMessage(chatId, text, { plain: true });
      return ids[0] ?? 0;
    },
    sendLongMessage: (chatId, text) => sendLongMessage(chatId, text),
    sendQuestionMessage,
    sendPhoto,
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

  // Shared sendMessage wrapper for MCP tools (plain text)
  const sendPlainMessage = async (chatId: number, text: string) => {
    await sendMessage(chatId, text, { plain: true });
  };

  // Shared sendPhoto wrapper for MCP tools
  const sendPhotoWrapper = async (chatId: number, photoPath: string, caption?: string) => {
    await sendPhoto(chatId, photoPath, caption);
  };

  // 9. Wire Telegram -> Concierg -> dispatch intents
  setMessageHandler(async (text, messageId, chatId, replyToMessageId, replyToText, image) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, replyToMessageId, replyToText, image, {
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

  setEditHandler(async (text, messageId, chatId) => {
    health.trackMessageStart(messageId);
    sendTypingAction(chatId);
    const typingInterval = setInterval(() => sendTypingAction(chatId), 4000);
    try {
      await processMessage(text, messageId, chatId, null, null, null, {
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

  // 10. Wire callback handler for inline keyboard buttons (questions, plans)
  setCallbackQueryHandler(async (data, messageId, chatId) => {
    log.info({ data, messageId, chatId }, "Callback query received");

    // Question answer: "answer:<questionId>:opt:<index>" or "answer:<questionId>:yes/no/skip"
    if (data.startsWith("answer:")) {
      const parts = data.split(":");
      const questionId = parseInt(parts[1], 10);
      if (isNaN(questionId)) return;

      let answer: string;
      if (parts[2] === "opt") {
        const optIndex = parseInt(parts[3], 10);
        answer = resolveOptionLabel(questionId, optIndex);
        clearQuestionOptions(questionId);
      } else if (parts[2] === "skip") {
        answer = "skip";
      } else {
        answer = parts[2]; // "yes" or "no"
      }

      const resolved = dispatcher.resolveQuestion(questionId, answer);
      if (!resolved) {
        log.warn({ questionId, answer }, "Question not found for callback");
      }
      return;
    }

    // Plan approval: "plan:<workerId>:approve" or "plan:<workerId>:reject"
    if (data.startsWith("plan:")) {
      const parts = data.split(":");
      const workerId = parseInt(parts[1], 10);
      if (isNaN(workerId)) return;

      const action = parts[2];
      if (action === "approve") {
        dispatcher.resolvePlan(workerId, "APPROVED: User approved the plan.");
      } else if (action === "reject") {
        dispatcher.resolvePlan(workerId, "REJECTED: User rejected the plan. Ask what to change.");
      }
      return;
    }
  });

  // Wire /restart command handler
  setRestartHandler(async () => {
    log.info("Performing graceful restart...");

    health.stop();
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

    // Spawn a new instance before exiting
    const child = spawn("node", ["--env-file=.env", "--import", "tsx", "src/index.ts"], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });
    child.unref();

    log.info("New process spawned, exiting current process.");
    process.exit(0);
  });

  // 11. Cold-register recent workers from DB (no SDK sessions started)
  await dispatcher.coldResumeWorkersFromDb();

  // 12. Start Watchdog (only monitors idle workers now)
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
    watchdog.stop();
    stopTokenRefreshLoop();
    await stopConciergSession();
    await dispatcher.stopAll();
    await stopBot();
    closeDb();

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
