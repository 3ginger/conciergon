import { markIntentProcessed } from "../db/queries.js";
import { updateMessageIntentId } from "../db/message-log.js";
import type { ClassifiedIntent } from "../types/index.js";
import { ConciergSession, type ImageData } from "./session.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("concierg");

let session: ConciergSession | null = null;

// --- Session lifecycle ---

export async function startConciergSession(): Promise<void> {
  session = new ConciergSession();
  await session.start();
  log.info("Concierg session started");
}

export async function stopConciergSession(): Promise<void> {
  if (session) {
    await session.stop();
    session = null;
  }
}

export async function pingConciergSession(): Promise<boolean> {
  if (!session || !session.isAlive()) return false;
  return session.ping();
}

// --- Main processMessage function ---
// Per message: hand the DB row id to the skill, then dispatch whatever intents it published.

export async function processMessage(
  _message: string,
  telegramMessageId: number,
  _telegramChatId: number,
  _replyToMessageId: number | null,
  _replyToText: string | null,
  _images: ImageData[] = [],
  messageRowId: number,
  deps: {
    sendMessage: (chatId: number, text: string) => Promise<void>;
    sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<void>;
    handleIntent: (intent: ClassifiedIntent & { id: number; messageRowId: number }) => Promise<void>;
  },
): Promise<void> {
  if (!session || !session.isAlive()) {
    log.warn("Concierg session not alive, restarting");
    session = new ConciergSession();
    await session.start();
  }

  const registeredIntents = await session.send(messageRowId, telegramMessageId);

  for (const ri of registeredIntents) {
    const intent: ClassifiedIntent = {
      type: ri.type,
      workerId: ri.workerId,
      telegramMessageId,
      data: ri.data as import("../types/index.js").IntentData,
    };

    updateMessageIntentId(messageRowId, ri.id);
    markIntentProcessed(ri.id);

    log.info({ type: ri.type, intentId: ri.id }, "Intent registered: %s", ri.type);

    await deps.handleIntent({ ...intent, id: ri.id, messageRowId });
  }
}
