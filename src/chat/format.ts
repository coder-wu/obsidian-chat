// Parse and serialize a chat markdown file.
//
// Layout:
//   ---
//   <YAML frontmatter (ChatMetadata)>
//   ---
//
//   ## 👤 User
//   <content>
//
//   ## 🤖 Assistant
//   <content>
//
// Only user/assistant turns are stored in the body. The system prompt lives in
// plugin settings and is not duplicated into each file.

import { parseYaml, stringifyYaml } from "obsidian";
import type { ChatMessage, ChatMetadata } from "../types";

const USER_HEADING = "## 👤 User";
const ASSISTANT_HEADING = "## 🤖 Assistant";
const USER_RE = /^## 👤 User\s*$/;
const ASSISTANT_RE = /^## 🤖 Assistant\s*$/;

// Thinking content is stored between these markers (HTML comments — invisible
// in Obsidian's reading view, but parseable by us).
const THINKING_START = "<!--thinking-->";
const THINKING_END = "<!--end-thinking-->";

const DEFAULT_METADATA: ChatMetadata = {
  title: "New chat",
  created: "",
  updated: "",
  provider: "",
  model: "",
  status: "active",
  summary: "",
  context: { files: [], folders: [] },
  usage: { inputTokens: 0, outputTokens: 0 },
};

/** Split a file into its raw frontmatter block and body. */
function splitFrontmatter(content: string): { fm: string; body: string } {
  if (!content.startsWith("---")) return { fm: "", body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { fm: "", body: content };
  const fm = content.slice(3, end).replace(/^\n/, "");
  const bodyStart = end + 4; // skip "\n---"
  let body = bodyStart >= content.length ? "" : content.slice(bodyStart);
  body = body.replace(/^\r?\n/, "");
  return { fm, body };
}

export function parseChatFile(content: string): {
  metadata: ChatMetadata;
  body: string;
} {
  const { fm, body } = splitFrontmatter(content);
  let parsed: any = {};
  if (fm.trim()) {
    try {
      parsed = parseYaml(fm) ?? {};
    } catch {
      parsed = {};
    }
  }
  const metadata: ChatMetadata = {
    ...DEFAULT_METADATA,
    ...parsed,
    context: {
      files: parsed?.context?.files ?? [],
      folders: parsed?.context?.folders ?? [],
    },
    usage: {
      inputTokens: parsed?.usage?.inputTokens ?? 0,
      outputTokens: parsed?.usage?.outputTokens ?? 0,
    },
  };
  return { metadata, body };
}

export function parseMessages(body: string): ChatMessage[] {
  const lines = body.split("\n");
  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current) {
      const raw = buf.join("\n").replace(/^\n+|\n+$/g, "");
      // Extract thinking content from HTML comment markers.
      const thinkMatch = raw.match(
        new RegExp(`${escapeRegex(THINKING_START)}([\s\S]*?)${escapeRegex(THINKING_END)}`)
      );
      if (thinkMatch) {
        current.thinking = thinkMatch[1].replace(/^\n+|\n+$/g, "");
        current.content = raw.replace(thinkMatch[0], "").replace(/^\n+|\n+$/g, "");
      } else {
        current.content = raw;
      }
      messages.push(current);
    }
    buf = [];
  };

  for (const line of lines) {
    if (USER_RE.test(line)) {
      flush();
      current = { role: "user", content: "" };
    } else if (ASSISTANT_RE.test(line)) {
      flush();
      current = { role: "assistant", content: "" };
    } else {
      buf.push(line);
    }
  }
  flush();
  return messages;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentToString(content: string | import("../types").ContentPart[]): string {
  if (typeof content === "string") return content;
  // For multimodal messages, extract text parts only. Image/document data is
  // not stored in the markdown file (too large, not human-readable).
  return content
    .filter((p): p is import("../types").TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

export function serializeMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const heading = m.role === "user" ? USER_HEADING : ASSISTANT_HEADING;
      let body = contentToString(m.content).trim();
      // Prepend thinking content if present.
      if (m.thinking && m.thinking.trim()) {
        body = `${THINKING_START}\n${m.thinking.trim()}\n${THINKING_END}\n\n${body}`;
      }
      return `${heading}\n\n${body}`;
    })
    .join("\n\n");
}

export function serializeChatFile(metadata: ChatMetadata, body: string): string {
  const fm = stringifyYaml(metadata as any).trim();
  const bodyTrim = body.replace(/^\n+|\n+$/g, "");
  return `---\n${fm}\n---\n\n${bodyTrim}\n`;
}
