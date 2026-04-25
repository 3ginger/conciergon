#!/usr/bin/env node
import { eq, and, desc } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { loadMessagePayload } from "../db/queries.js";
import { bootstrap, out, fail, parseArgs } from "./shared.js";

bootstrap();

const { positional, flags } = parseArgs(process.argv.slice(2));

if (flags["telegram-id"] !== undefined && flags["chat-id"] !== undefined) {
  const tgId = Number(flags["telegram-id"]);
  const chatId = Number(flags["chat-id"]);
  if (!Number.isFinite(tgId) || !Number.isFinite(chatId)) {
    fail("invalid --telegram-id or --chat-id");
  }
  const row = getDb()
    .select()
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramMessageId, tgId),
        eq(schema.telegramMessages.telegramChatId, chatId),
      ),
    )
    .orderBy(desc(schema.telegramMessages.id))
    .limit(1)
    .get();

  if (!row) out(null);
  out(loadMessagePayload(row!.id));
} else if (positional[0]) {
  const id = Number(positional[0]);
  if (!Number.isFinite(id)) fail("invalid message id");
  const payload = loadMessagePayload(id);
  if (!payload) out(null);
  out(payload);
} else {
  fail("usage: load-message <db-id>  OR  load-message --telegram-id N --chat-id N");
}
