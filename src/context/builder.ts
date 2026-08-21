// Build context from attached files and folders.
//
// Text files → TextPart (full contents).
// Images     → ImagePart (base64). Sent as multimodal content.
// PDFs       → TextPart (text extracted via unpdf). OpenAI has no native PDF
//              support, so we extract text. (Anthropic supports native PDFs
//              via DocumentPart, but since OpenAI is primary, we extract text
//              for both to keep behavior consistent.)

import { App, TFile, normalizePath } from "obsidian";
import { extractText, getDocumentProxy } from "unpdf";
import type { ChatContext, ContentPart, ImagePart, TextPart } from "../types";
import { estimateTokens } from "../chat/tokenEstimate";

export interface BuiltContext {
  /** Text parts for the system message (file contents, folder trees, PDF text). */
  textParts: TextPart[];
  /** Binary parts for the user message (images). */
  imageParts: ImagePart[];
  tokens: number;
  fileCount: number;
  skippedCount: number;
  notes: string[];
}

export interface BuildContextOptions {
  /** Skip text files larger than this many bytes. */
  maxFileBytes: number;
  /** Skip images larger than this many bytes (larger — images are expected to be big). */
  maxImageBytes: number;
  extensions: Set<string>;
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
]);

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "markdown", "canvas", "csv", "json", "yaml", "yml",
  "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "c", "cpp", "h", "hpp", "sh", "bash", "zsh", "html", "css",
  "xml", "toml", "ini", "env", "log", "sql",
]);

export const DEFAULT_CONTEXT_OPTIONS: BuildContextOptions = {
  maxFileBytes: 512 * 1024,       // 512 KB for text files
  maxImageBytes: 20 * 1024 * 1024, // 20 MB for images (OpenAI limit)
  extensions: new Set([...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, "pdf"]),
};

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= 0) return "";
  return path.slice(idx + 1).toLowerCase();
}

function toBase64(bytes: ArrayBuffer): string {
  const bytes8 = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes8.length; i += chunk) {
    binary += String.fromCharCode(...bytes8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function extractPdfText(
  app: App,
  file: TFile,
  maxPages: number
): Promise<string> {
  const buf = await app.vault.readBinary(file);
  const data = new Uint8Array(buf);
  const pdf = await getDocumentProxy(data);
  const totalPages = pdf.numPages;
  const pages = Math.min(totalPages, maxPages);
  // extractText with mergePages:true returns all pages joined. We can't limit
  // pages via the API, so we extract all and note if truncated.
  const { text } = await extractText(pdf, { mergePages: true });
  const note =
    totalPages > maxPages
      ? `\n\n[PDF has ${totalPages} pages; showing all extracted text]`
      : "";
  return text + note;
}

export async function buildContext(
  app: App,
  ctx: ChatContext,
  opts: BuildContextOptions = DEFAULT_CONTEXT_OPTIONS
): Promise<BuiltContext> {
  const notes: string[] = [];
  const textParts: TextPart[] = [];
  const imageParts: ImagePart[] = [];
  let fileCount = 0;
  let skippedCount = 0;
  const MAX_PDF_PAGES = 30;

  const seen = new Set<string>();

  const processFile = async (file: TFile): Promise<void> => {
    const key = file.path;
    if (seen.has(key)) return;
    seen.add(key);

    const ext = extOf(file.path);
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const sizeLimit = isImage ? opts.maxImageBytes : opts.maxFileBytes;

    // Size check
    if (file.stat.size > sizeLimit) {
      notes.push(
        `Skipped large file: ${file.path} (${(file.stat.size / 1024).toFixed(0)} KB)`
      );
      skippedCount++;
      return;
    }

    // Image → ImagePart (base64)
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const buf = await app.vault.readBinary(file);
        const mediaType = IMAGE_MEDIA_TYPES[ext] ?? "image/png";
        imageParts.push({
          type: "image",
          mediaType,
          data: toBase64(buf),
        });
        fileCount++;
      } catch {
        notes.push(`Could not read image: ${file.path}`);
        skippedCount++;
      }
      return;
    }

    // PDF → extract text
    if (ext === "pdf") {
      try {
        const text = await extractPdfText(app, file, MAX_PDF_PAGES);
        textParts.push({
          type: "text",
          text: `### ${file.path} (PDF text)\n\n${text}`,
        });
        fileCount++;
      } catch (e) {
        notes.push(
          `Could not extract PDF text: ${file.path} (${(e as Error).message})`
        );
        skippedCount++;
      }
      return;
    }

    // Text file → TextPart
    if (TEXT_EXTENSIONS.has(ext) || opts.extensions.has(ext)) {
      try {
        const content = await app.vault.read(file);
        textParts.push({
          type: "text",
          text: `### ${file.path}\n\n${content}`,
        });
        fileCount++;
      } catch {
        notes.push(`Could not read: ${file.path}`);
        skippedCount++;
      }
      return;
    }
  };

  // Individual files (folders are expanded into files at attach time, so
  // we only ever process ctx.files here — no folder special-casing).
  for (const path of ctx.files) {
    const file = app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) {
      await processFile(file);
    } else {
      notes.push(`Not found: ${path}`);
      skippedCount++;
    }
  }

  // Token estimate from text parts only (images are billed differently).
  const allText = textParts.map((p) => p.text).join("\n\n");
  const tokens = estimateTokens(allText);

  return {
    textParts,
    imageParts,
    tokens,
    fileCount,
    skippedCount,
    notes,
  };
}
