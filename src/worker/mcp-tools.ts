import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-code";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("worker-mcp");

/**
 * Per-worker context passed via closure to MCP tools.
 * Each WorkerLLM gets its own MCP server instance.
 */
export interface WorkerMcpContext {
  workerId: number;
  emoji: string;
  chatId: number;
  sendMessage: (chatId: number, text: string) => Promise<number>;
  sendPhoto: (chatId: number, photoPath: string, caption?: string) => Promise<number>;
  /** Track which worker sent which Telegram message (for reply routing) */
  trackMessage: (telegramMsgId: number, workerId: number) => void;
}

/**
 * Factory: creates a per-worker MCP server with tools to send messages
 * directly to the user's Telegram chat.
 */
export function createWorkerMcpServer(ctx: WorkerMcpContext) {
  const sendTelegramMessage = tool(
    "send_telegram_message",
    "Send a message to the user in Telegram. Use this to report progress, share findings, or communicate with the user. Your worker ID and emoji are added automatically.",
    { text: z.string().describe("The message text to send to the user") },
    async (args) => {
      if (!args.text?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: text cannot be empty" }] };
      }
      try {
        const prefixed = `${ctx.emoji} #${ctx.workerId}: ${args.text}`;
        const msgId = await ctx.sendMessage(ctx.chatId, prefixed);
        ctx.trackMessage(msgId, ctx.workerId);
        return { content: [{ type: "text" as const, text: "Message sent successfully" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "send_telegram_message failed");
        return { content: [{ type: "text" as const, text: `Error sending message: ${msg}` }] };
      }
    }
  );

  const sendTelegramPhoto = tool(
    "send_telegram_photo",
    "Send a photo to the user in Telegram. The photo must be a local file path.",
    {
      photo_path: z.string().describe("Absolute path to the image file on disk"),
      caption: z.string().optional().describe("Optional caption for the photo"),
    },
    async (args) => {
      if (!args.photo_path?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: photo_path cannot be empty" }] };
      }
      try {
        const caption = args.caption
          ? `${ctx.emoji} #${ctx.workerId}: ${args.caption}`
          : `${ctx.emoji} #${ctx.workerId}`;
        const msgId = await ctx.sendPhoto(ctx.chatId, args.photo_path, caption);
        ctx.trackMessage(msgId, ctx.workerId);
        return { content: [{ type: "text" as const, text: "Photo sent successfully" }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err, workerId: ctx.workerId }, "send_telegram_photo failed");
        return { content: [{ type: "text" as const, text: `Error sending photo: ${msg}` }] };
      }
    }
  );

  return createSdkMcpServer({
    name: "worker_telegram",
    tools: [sendTelegramMessage, sendTelegramPhoto],
  });
}
