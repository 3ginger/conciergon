import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  font-size: 15px;
  line-height: 1.6;
  color: #1a1a1a;
  background: #fff;
  padding: 20px 16px;
  max-width: 720px;
  margin: 0 auto;
}
h1, h2, h3, h4 {
  margin: 1.4em 0 0.5em;
  line-height: 1.3;
}
h1 { font-size: 1.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.3em; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.1em; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 0.6em 0; }
ul, ol { margin: 0.5em 0 0.5em 1.5em; }
li { margin: 0.2em 0; }
code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.88em;
  background: #f0f0f0;
  padding: 0.15em 0.35em;
  border-radius: 3px;
}
pre {
  margin: 0.8em 0;
  padding: 12px 14px;
  background: #f5f5f5;
  border-radius: 6px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  line-height: 1.5;
}
blockquote {
  margin: 0.6em 0;
  padding: 0.4em 0 0.4em 14px;
  border-left: 3px solid #ccc;
  color: #555;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 0.9em;
  overflow-x: auto;
  display: block;
}
th, td {
  border: 1px solid #ddd;
  padding: 6px 10px;
  text-align: left;
}
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) td { background: #fafafa; }
a { color: #2481cc; text-decoration: none; }
hr { border: none; border-top: 1px solid #e0e0e0; margin: 1.2em 0; }
img { max-width: 100%; }

@media (prefers-color-scheme: dark) {
  body { color: #e0e0e0; background: #1a1a1a; }
  h1 { border-bottom-color: #333; }
  code { background: #2a2a2a; }
  pre { background: #242424; }
  blockquote { border-left-color: #444; color: #aaa; }
  th { background: #2a2a2a; }
  th, td { border-color: #333; }
  tr:nth-child(even) td { background: #222; }
  a { color: #5eaadd; }
  hr { border-top-color: #333; }
}
`;

export function markdownToHtmlDocument(
  markdown: string,
  options?: { title?: string },
): string {
  const title = options?.title ?? "Plan";
  const body = md.render(markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}
