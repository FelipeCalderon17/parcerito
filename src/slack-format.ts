/** Converts the Markdown Claude writes into Slack mrkdwn, leaving code blocks and inline code alone. */
export function toSlackMrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith("```") ? part : convertProse(part)))
    .join("");
}

function convertProse(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (part.startsWith("`")) return part;
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
    })
    .join("");
}

/** Splits long text into Slack-sized chunks, preferring to break on blank lines, then newlines. */
export function chunkMessage(text: string, max = 3500): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
