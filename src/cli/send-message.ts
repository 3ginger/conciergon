#!/usr/bin/env node
import { Bot } from "grammy";
import { insertTelegramMessage } from "../db/message-log.js";
import { bootstrap, getConfig, out, fail, parseArgs } from "./shared.js";

bootstrap();

const { flags } = parseArgs(process.argv.slice(2));
const chatId = Number(flags["chat-id"]);
const text = typeof flags["text"] === "string" ? flags["text"] : "";
const source = typeof flags["source"] === "string" ? flags["source"] : "concierg";
const workerIdRaw = flags["worker-id"];
const workerId = typeof workerIdRaw === "string" ? Number(workerIdRaw) : null;
const replyToRaw = flags["reply-to-message-id"];
const replyToId = typeof replyToRaw === "string" ? Number(replyToRaw) : null;

if (!Number.isFinite(chatId)) fail("send-message requires --chat-id <int>");
if (!text) fail("send-message requires --text <string>");

const config = getConfig();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

try {
  const sent = await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...(replyToId ? { reply_parameters: { message_id: replyToId } } : {}),
  });

  const row = insertTelegramMessage({
    telegramMessageId: sent.message_id,
    telegramChatId: chatId,
    direction: "out",
    source,
    text,
    workerId: workerId ?? null,
  });

  out({ telegram_message_id: sent.message_id, row_id: row.id });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  fail(`sendMessage failed: ${msg}`);
}
