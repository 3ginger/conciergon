#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Bot, InputFile } from "grammy";
import { insertTelegramMessage } from "../db/message-log.js";
import { bootstrap, getConfig, out, fail, parseArgs } from "./shared.js";

bootstrap();

const { flags } = parseArgs(process.argv.slice(2));
const chatId = Number(flags["chat-id"]);
const path = typeof flags["path"] === "string" ? flags["path"] : "";
const caption = typeof flags["caption"] === "string" ? flags["caption"] : undefined;
const source = typeof flags["source"] === "string" ? flags["source"] : "concierg";
const workerIdRaw = flags["worker-id"];
const workerId = typeof workerIdRaw === "string" ? Number(workerIdRaw) : null;

if (!Number.isFinite(chatId)) fail("send-photo requires --chat-id <int>");
if (!path) fail("send-photo requires --path <file>");
if (!existsSync(path)) fail(`file not found: ${path}`);

const config = getConfig();
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

try {
  const sent = await bot.api.sendPhoto(chatId, new InputFile(path), caption ? { caption } : undefined);

  const row = insertTelegramMessage({
    telegramMessageId: sent.message_id,
    telegramChatId: chatId,
    direction: "out",
    source,
    text: caption ?? null,
    imagePaths: [path],
    workerId: workerId ?? null,
  });

  out({ telegram_message_id: sent.message_id, row_id: row.id });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  fail(`sendPhoto failed: ${msg}`);
}
