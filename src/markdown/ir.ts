import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownIR, MarkdownStyle, MarkdownStyleSpan, MarkdownLinkSpan, MarkdownParseOptions } from "./types.js";

interface RenderTarget {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
  openStyles: Array<{ style: MarkdownStyle; start: number; meta?: Record<string, string> }>;
  listStack: Array<{ ordered: boolean; counter: number }>;
  currentHeadingTag: string;
  tableCol: number;
  tableHeaderCols: number;
}

interface RenderContext {
  headingStyle: "none" | "bold";
  enableSpoilers: boolean;
}

/**
 * Parse a markdown string into an IR.
 * Uses markdown-it for tokenization, then recursively walks tokens.
 */
export function markdownToIR(
  markdown: string,
  options: MarkdownParseOptions = {},
): MarkdownIR {
  const { linkify = true, headingStyle = "bold", enableSpoilers = false } = options;

  const md = new MarkdownIt({ linkify, html: false, breaks: true });
  const tokens = md.parse(markdown, {});

  const target: RenderTarget = {
    text: "",
    styles: [],
    links: [],
    openStyles: [],
    listStack: [],
    currentHeadingTag: "",
    tableCol: 0,
    tableHeaderCols: 0,
  };

  renderTokens(tokens, target, { headingStyle, enableSpoilers });

  // Close any unclosed styles
  while (target.openStyles.length > 0) {
    closeStyle(target, target.openStyles[target.openStyles.length - 1].style);
  }

  return {
    text: target.text.trimEnd(),
    styles: target.styles,
    links: target.links,
  };
}

function renderTokens(
  tokens: Token[],
  target: RenderTarget,
  ctx: RenderContext,
): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token.type) {
      case "inline":
        if (token.children) renderTokens(token.children, target, ctx);
        break;

      case "text":
        target.text += token.content;
        break;

      case "softbreak":
      case "hardbreak":
        target.text += "\n";
        break;

      case "strong_open":
        openStyle(target, "bold");
        break;
      case "strong_close":
        closeStyle(target, "bold");
        break;

      case "em_open":
        openStyle(target, "italic");
        break;
      case "em_close":
        closeStyle(target, "italic");
        break;

      case "s_open":
        openStyle(target, "strikethrough");
        break;
      case "s_close":
        closeStyle(target, "strikethrough");
        break;

      case "code_inline":
        openStyle(target, "code");
        target.text += token.content;
        closeStyle(target, "code");
        break;

      case "fence": {
        const lang = token.info.trim();
        openStyle(target, "code_block", lang ? { language: lang } : undefined);
        target.text += token.content.replace(/\n$/, "");
        closeStyle(target, "code_block");
        target.text += "\n";
        break;
      }
      case "code_block":
        openStyle(target, "code_block");
        target.text += token.content.replace(/\n$/, "");
        closeStyle(target, "code_block");
        target.text += "\n";
        break;

      case "link_open": {
        const href = token.attrGet("href") || "";
        target.links.push({ start: target.text.length, end: -1, href });
        break;
      }
      case "link_close": {
        const openLink = target.links[target.links.length - 1];
        if (openLink && openLink.end === -1) {
          openLink.end = target.text.length;
        }
        break;
      }

      case "heading_open":
        target.currentHeadingTag = token.tag;
        if (ctx.headingStyle === "bold") {
          openStyle(target, "bold");
          if (token.tag >= "h3") openStyle(target, "italic");
        }
        break;
      case "heading_close":
        if (ctx.headingStyle === "bold") {
          if (target.currentHeadingTag >= "h3") closeStyle(target, "italic");
          closeStyle(target, "bold");
        }
        target.text += "\n";
        if (target.currentHeadingTag === "h1") target.text += "━━━\n";
        target.currentHeadingTag = "";
        break;

      case "blockquote_open":
        openStyle(target, "blockquote");
        break;
      case "blockquote_close":
        closeStyle(target, "blockquote");
        break;

      case "paragraph_open":
        break;
      case "paragraph_close":
        target.text += "\n\n";
        break;

      case "bullet_list_open":
        target.listStack.push({ ordered: false, counter: 0 });
        break;
      case "ordered_list_open": {
        const start = Number(token.attrGet("start")) || 1;
        target.listStack.push({ ordered: true, counter: start });
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close":
        target.listStack.pop();
        break;

      case "list_item_open": {
        const list = target.listStack[target.listStack.length - 1];
        if (list?.ordered) {
          target.text += `${list.counter}. `;
          list.counter++;
        } else {
          target.text += "- ";
        }
        break;
      }
      case "list_item_close":
        if (!target.text.endsWith("\n")) target.text += "\n";
        break;

      case "hr":
        target.text += "---\n";
        break;

      case "image": {
        const alt = token.children?.map((c: Token) => c.content).join("") || "";
        const src = token.attrGet("src") || "";
        if (alt) target.text += alt;
        if (src) {
          target.links.push({
            start: target.text.length - alt.length,
            end: target.text.length,
            href: src,
          });
        }
        break;
      }

      case "html_block":
      case "html_inline":
        target.text += token.content;
        break;

      // --- Tables: render as preformatted text ---
      case "table_open":
        openStyle(target, "code_block");
        target.tableCol = 0;
        target.tableHeaderCols = 0;
        break;
      case "table_close":
        closeStyle(target, "code_block");
        target.text += "\n";
        break;

      case "thead_open":
      case "tbody_open":
      case "tbody_close":
        break;
      case "thead_close": {
        // Add separator line after header row
        const sep = Array.from({ length: target.tableHeaderCols }, () => "---").join(" | ");
        target.text += sep + "\n";
        break;
      }

      case "tr_open":
        target.tableCol = 0;
        break;
      case "tr_close":
        target.text += "\n";
        break;

      case "th_open":
      case "td_open":
        if (target.tableCol > 0) target.text += " | ";
        target.tableCol++;
        if (token.type === "th_open") target.tableHeaderCols = target.tableCol;
        break;
      case "th_close":
      case "td_close":
        break;
    }
  }
}

function openStyle(target: RenderTarget, style: MarkdownStyle, meta?: Record<string, string>): void {
  target.openStyles.push({ style, start: target.text.length, meta });
}

function closeStyle(target: RenderTarget, style: MarkdownStyle): void {
  for (let i = target.openStyles.length - 1; i >= 0; i--) {
    if (target.openStyles[i].style === style) {
      const { start, meta } = target.openStyles[i];
      target.openStyles.splice(i, 1);
      if (target.text.length > start) {
        const span: MarkdownStyleSpan = { start, end: target.text.length, style };
        if (meta) span.meta = meta;
        target.styles.push(span);
      }
      return;
    }
  }
}
