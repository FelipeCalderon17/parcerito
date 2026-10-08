import fs from "node:fs";
import path from "node:path";

export interface SlackFile {
  name: string;
  mimetype: string;
  size: number;
  url: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const READABLE = /^(image\/(png|jpe?g|gif|webp)|text\/|application\/(json|pdf|xml|x-yaml))/;

/** Picks the fields we need from Slack's file objects (shape varies by event type). */
export function slackFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    const url = f?.url_private_download ?? f?.url_private;
    return url ? [{ name: String(f.name ?? "file"), mimetype: String(f.mimetype ?? ""), size: Number(f.size ?? 0), url }] : [];
  });
}

/**
 * Downloads attachments into the thread folder so Claude can open them with its Read tool
 * (it can see images and PDFs). Returns a note to append to the prompt.
 */
export async function saveAttachments(files: SlackFile[], dir: string, botToken: string): Promise<string> {
  if (files.length === 0) return "";
  fs.mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (!READABLE.test(file.mimetype) || file.size > MAX_BYTES) {
      skipped.push(`${file.name} (${file.mimetype || "unknown type"})`);
      continue;
    }
    try {
      const res = await fetch(file.url, { headers: { Authorization: `Bearer ${botToken}` } });
      // Without the files:read scope Slack answers with an HTML login page instead of the file.
      if (!res.ok || (res.headers.get("content-type") ?? "").startsWith("text/html")) {
        throw new Error(`HTTP ${res.status}`);
      }
      const target = path.join(dir, `${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`);
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      saved.push(target);
    } catch (error) {
      console.warn(`Could not download ${file.name}:`, error);
      skipped.push(`${file.name} (couldn't download it)`);
    }
  }

  const lines: string[] = [];
  if (saved.length) lines.push(`I attached these files; open them with the Read tool:\n${saved.map((p) => `- ${p}`).join("\n")}`);
  if (skipped.length) lines.push(`I also attached files you can't open: ${skipped.join(", ")}. Tell me if you need them.`);
  return `\n\n${lines.join("\n\n")}`;
}
