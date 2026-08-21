import {
  ItemView,
  MarkdownRenderer,
  Notice,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type ObsidianAIPlugin from "../main";
import type {
  ChatContext,
  ChatMessage,
  ChatMetadata,
  ChatUsage,
  ContentPart,
  TextPart,
} from "../types";
import {
  parseChatFile,
  parseMessages,
  serializeChatFile,
  serializeMessages,
} from "../chat/format";
import { buildContext } from "../context/builder";
import {
  ChatFileSuggestModal,
  FileSuggestModal,
  FolderSuggestModal,
} from "../context/picker";

export const CHAT_VIEW_TYPE = "obsidian-chat";

function nowStamp(): string {
  // YYYY-MM-DD-HHmmss in local time, for unique file names.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function sanitizeTitle(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
}

// Extract text from a message's content (string or ContentPart[]).
function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

// IMPORTANT: with useDefineForClassFields:false, the `!` declarations below are
// type-only (no runtime property), so they CANNOT shadow Obsidian core's
// internal View properties (e.g. core's own titleEl). Do not re-enable
// useDefineForClassFields without renaming these to avoid collisions.
export class ChatView extends ItemView {
  plugin: ObsidianAIPlugin;

  // ---- chat state ----
  file: TFile | null = null;
  messages: ChatMessage[] = [];
  context: ChatContext = { files: [], folders: [] };
  usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
  created = "";
  private busy = false;
  private abortController: AbortController | null = null;
  private contextTokens = 0;
  private contextNotes: string[] = [];
  private contextFileCount = 0;
  private contextSkippedCount = 0;
  private contextImageCount = 0;

  // ---- DOM refs (type-only via !, assigned in buildDom) ----
  private rootEl!: HTMLElement;
  private aiTitleEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextItemsEl!: HTMLElement;
  private contextTokensEl!: HTMLElement;
  private contextCountEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;

  // ---- lifecycle state ----
  private pendingState: unknown | null = null;
  private domReady = false;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "New AI chat";
  }

  getIcon(): string {
    return "message-square";
  }

  // ---- lifecycle ----
  // Obsidian may call setState() before onOpen() builds the DOM. We hold the
  // state aside and apply it once the DOM is ready.
  async onOpen(): Promise<void> {
    try {
      this.buildDom();
      this.domReady = true;
      if (this.pendingState !== null) {
        const s = this.pendingState;
        this.pendingState = null;
        await this.applyState(s);
      } else {
        await this.newChat();
      }
    } catch (e) {
      console.error("[obsidian-chat] onOpen failed:", e);
      throw e;
    }
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  // NOTE: signature must match ItemView.setState(state, result).
  async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    if (!this.domReady) {
      this.pendingState = state;
      return;
    }
    await this.applyState(state);
  }

  private async applyState(state: unknown): Promise<void> {
    const s = state as { file?: string | null } | null;
    if (s?.file) {
      const f = this.app.vault.getAbstractFileByPath(s.file);
      if (f instanceof TFile) {
        await this.loadFromFile(f);
        return;
      }
    }
    await this.newChat();
  }

  // ---- DOM ----

  private buildDom(): void {
    // position:relative so .obsidian-chat (position:absolute; inset:0)
    // fills this container reliably on both desktop and mobile.
    this.contentEl.style.position = "relative";

    const root = this.contentEl.createDiv({ cls: "obsidian-chat" });
    this.rootEl = root;

    // On mobile, Obsidian adds margin-top to .view-content to make room for the
    // navbar + view-header. We hide the view-header (redundant with our toolbar)
    // but Obsidian pre-computed the margin INCLUDING the view-header's space.
    // So we must reduce the margin by the view-header's height. We do this in a
    // setTimeout so Obsidian has applied its layout first. This is adaptive —
    // we read actual values, not hardcoded ones.
    setTimeout(() => this.adjustMobileMargin(), 100);

    // toolbar
    const toolbar = root.createDiv({ cls: "ai-toolbar" });
    this.aiTitleEl = toolbar.createDiv({ cls: "ai-title", attr: { contenteditable: "true", spellcheck: "false" } });
    this.aiTitleEl.setText("New AI chat");
    // Save edited title → rename the file.
    this.aiTitleEl.addEventListener("blur", () => this.onTitleEdited());
    this.aiTitleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    });
    this.usageEl = toolbar.createDiv({ cls: "ai-usage" });
    new Setting(toolbar)
      .addButton((b) =>
        b.setIcon("file-plus-2").setTooltip("New chat").onClick(() => this.newChat())
      )
      .addButton((b) =>
        b
          .setIcon("folder-open")
          .setTooltip("Resume a chat")
          .onClick(() => this.openResumePicker())
      )
      .settingEl.style.setProperty("padding", "0");

    // context bar — compact: just a button to open the context tab + summary
    const ctx = root.createDiv({ cls: "ai-context" });
    const ctxBtn = ctx.createDiv({ cls: "ai-context-btn" });
    setIcon(ctxBtn, "paperclip");
    ctxBtn.createSpan({ cls: "ai-context-btn-text", text: "Context" });
    this.contextCountEl = ctxBtn.createSpan({ cls: "ai-context-btn-count" });
    ctxBtn.addEventListener("click", () => this.plugin.openContextView());
    this.contextTokensEl = ctx.createDiv({ cls: "ai-context-tokens" });
    this.contextEl = ctx;
    // Hidden items element kept for compatibility but unused now.
    this.contextItemsEl = ctx.createDiv({ cls: "ai-context-items", attr: { style: "display:none" } });

    // messages
    this.messagesEl = root.createDiv({ cls: "ai-messages" });

    // composer
    const composer = root.createDiv({ cls: "ai-composer" });
    this.inputEl = composer.createEl("textarea", {
      attr: { placeholder: "Type a message… (⌘/Ctrl+Enter to send)" },
    });
    this.inputEl.addEventListener("input", () => this.autosizeTextarea());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!this.busy) this.onSend();
      }
    });
    const row = composer.createDiv({ cls: "ai-composer-row" });
    this.hintEl = row.createDiv({ cls: "ai-hint" });
    this.sendBtn = row.createEl("button", { text: "Send" });
    this.sendBtn.addEventListener("click", () => {
      if (this.busy) this.abortRequest();
      else this.onSend();
    });
  }

  // ---- state actions ----

  // Called by ContextView when context changes externally — updates the chat
  // view's context display and persists to the chat file.
  async onContextChanged(): Promise<void> {
    await this.updateContextEstimate();
  }

  async newChat(): Promise<void> {
    if (!this.domReady || !this.inputEl) return; // not ready yet; state path handles it
    this.abortController?.abort();
    this.file = null;
    this.messages = [];
    this.context = { files: [], folders: [] };
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.created = new Date().toISOString();
    this.contextTokens = 0;
    this.contextNotes = [];
    this.inputEl.value = "";
    this.autosizeTextarea();
    await this.renderMessages();
    this.renderContext();
    this.updateStatus();
    this.setBusy(false);
  }

  async loadFromFile(file: TFile): Promise<void> {
    if (!this.domReady || !this.inputEl) return; // not ready yet; state path handles it
    const raw = await this.app.vault.read(file);
    const { metadata, body } = parseChatFile(raw);
    this.file = file;
    this.messages = parseMessages(body);
    this.context = metadata.context ?? { files: [], folders: [] };
    this.usage = metadata.usage ?? { inputTokens: 0, outputTokens: 0 };
    this.created = metadata.created || new Date().toISOString();
    await this.renderMessages();
    this.renderContext();
    this.updateStatus();
    await this.updateContextEstimate();
    this.setBusy(false);
  }

  private openResumePicker(): void {
    new ChatFileSuggestModal(this.app, this.plugin.settings.chatFolder, async (f) => {
      await this.loadFromFile(f);
    }).open();
  }

  // ---- context ----

  addFile(): void {
    new FileSuggestModal(this.app, async (f) => {
      if (!this.context.files.includes(f.path)) {
        this.context.files.push(f.path);
        await this.persistContext();
        this.renderContext();
        await this.updateContextEstimate();
      }
    }).open();
  }

  addFolder(): void {
    new FolderSuggestModal(this.app, async (folder) => {
      const opts = this.plugin.contextOptions;
      const prefix = folder.path === "/" ? "" : folder.path + "/";

      // Use the vault's file index (getFiles) rather than walking folder.children,
      // because on mobile folder.children may be empty (lazy loading). getFiles()
      // returns all TFiles that the vault has indexed.
      const allFiles = this.app.vault.getFiles();
      const files = allFiles.filter(
        (f) => f.path.startsWith(prefix) &&
               opts.extensions.has(f.extension.toLowerCase())
      );

      console.log("[obsidian-chat] addFolder:", {
        folder: folder.path,
        prefix,
        totalVaultFiles: allFiles.length,
        matchedFiles: files.length,
        matchedPaths: files.slice(0, 20).map((f) => f.path),
        extensionsInOpts: Array.from(opts.extensions).slice(0, 10),
      });

      let added = 0;
      for (const file of files) {
        if (!this.context.files.includes(file.path)) {
          this.context.files.push(file.path);
          added++;
        }
      }
      if (added === 0) {
        new Notice(`No attachable files found in "${folder.path}"`);
      } else {
        new Notice(`Added ${added} file${added === 1 ? "" : "s"} from "${folder.path}"`);
      }
      await this.persistContext();
      this.renderContext();
      await this.updateContextEstimate();
    }).open();
  }

  clearContext(): void {
    this.context = { files: [], folders: [] };
    this.contextTokens = 0;
    this.contextNotes = [];
    this.renderContext();
    this.updateStatus();
    void this.persistContext();
  }

  private removeContextItem(kind: "file" | "folder", path: string): void {
    if (kind === "file") {
      this.context.files = this.context.files.filter((p) => p !== path);
    } else {
      this.context.folders = this.context.folders.filter((p) => p !== path);
    }
    this.renderContext();
    void this.updateContextEstimate();
    void this.persistContext();
  }

  private async persistContext(): Promise<void> {
    // Update the file's frontmatter so attachments survive a reload/resume.
    if (this.file && this.messages.length) {
      await this.saveFile();
    }
  }

  private async updateContextEstimate(): Promise<void> {
    if (!this.context.files.length && !this.context.folders.length) {
      this.contextTokens = 0;
      this.contextNotes = [];
      this.contextFileCount = 0;
      this.contextSkippedCount = 0;
      this.contextImageCount = 0;
      this.renderContext();
      this.updateStatus();
      return;
    } else {
      const built = await buildContext(
        this.app,
        this.context,
        this.plugin.contextOptions
      );
      this.contextTokens = built.tokens;
      this.contextNotes = built.notes;
      this.contextFileCount = built.fileCount;
      this.contextSkippedCount = built.skippedCount;
      this.contextImageCount = built.imageParts.length;
    }
    this.renderContext();
    this.updateStatus();
  }

  private renderContext(): void {
    if (!this.contextCountEl) return;
    const count = this.context.files.length + this.context.folders.length;
    // Show count badge on the context button.
    this.contextCountEl.setText(count > 0 ? `(${count})` : "");
    // Show token summary next to the button.
    if (count === 0) {
      this.contextTokensEl.style.display = "none";
    } else {
      this.contextTokensEl.style.display = "";
      const parts: string[] = [];
      if (this.contextFileCount > 0) {
        parts.push(`${this.contextFileCount} file${this.contextFileCount === 1 ? "" : "s"}`);
      }
      if (this.contextImageCount > 0) {
        parts.push(`${this.contextImageCount} image${this.contextImageCount === 1 ? "" : "s"}`);
      }
      parts.push(`~${this.contextTokens} tokens`);
      if (this.contextSkippedCount > 0) {
        parts.push(`${this.contextSkippedCount} skipped`);
      }
      this.contextTokensEl.setText(parts.join(" · "));
      if (this.contextNotes.length) {
        this.contextTokensEl.setAttribute("title", this.contextNotes.join("\n"));
      } else {
        this.contextTokensEl.removeAttribute("title");
      }
    }
  }

  // ---- messages ----

  private async renderMessages(): Promise<void> {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    if (!this.messages.length) {
      const empty = this.messagesEl.createDiv({ cls: "ai-empty" });
      empty.createEl("p", {
        text: "Start a new chat. Attach vault files or folders as context above.",
      });
      empty.createEl("p", {
        text: "Every chat is saved as a markdown file in your vault.",
      });
      return;
    }
    for (const m of this.messages) {
      const wrap = this.messagesEl.createDiv({
        cls: `chat-message chat-message-${m.role}`,
      });
      wrap.createDiv({
        cls: "chat-message-role",
        text: m.role === "user" ? "👤 You" : "🤖 Assistant",
      });
      const body = wrap.createDiv({ cls: "chat-message-body" });
      // Show thinking in a collapsible section above the response.
      if (m.thinking && m.thinking.trim() && this.plugin.settings.showThinking) {
        const thinking = body.createEl("details", { cls: "ai-thinking" });
        thinking.createEl("summary", { text: "💭 Thinking…" });
        const thinkingBody = thinking.createDiv({ cls: "ai-thinking-body" });
        await MarkdownRenderer.renderMarkdown(
          m.thinking,
          thinkingBody,
          this.file?.path ?? "",
          this
        );
      }
      await MarkdownRenderer.renderMarkdown(
        messageText(m.content),
        body,
        this.file?.path ?? "",
        this
      );
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // ---- send / abort ----

  private async buildRequestMessages(): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    const built = await buildContext(
      this.app,
      this.context,
      this.plugin.contextOptions
    );

    // Log what context is actually being sent, for debugging.
    console.log("[obsidian-chat] buildRequestMessages: context", {
      textParts: built.textParts.length,
      imageParts: built.imageParts.length,
      fileCount: built.fileCount,
      skippedCount: built.skippedCount,
      notes: built.notes,
      contextInState: this.context,
    });

    // Text context (file contents, folder trees, PDF text) → system message.
    const systemParts: string[] = [];
    if (this.plugin.settings.systemPrompt.trim()) {
      systemParts.push(this.plugin.settings.systemPrompt.trim());
    }
    if (built.textParts.length) {
      const header =
        "# Vault context\n\nThe following is from the user's Obsidian vault, attached as context for this conversation.";
      systemParts.push(header + "\n\n" + built.textParts.map((p) => p.text).join("\n\n"));
    }
    if (systemParts.length) {
      messages.push({ role: "system", content: systemParts.join("\n\n") });
    }

    // Copy all messages. If there are image parts, attach them to the last
    // user message as multimodal content (images can't go in system messages).
    // Also prepend a context summary to the last user message so the AI
    // reliably acknowledges what's attached (LLMs pay more attention to user
    // message content than system messages).
    messages.push(...this.messages);

    // Build a short context summary string for the user message.
    let contextSummary = "";
    if (built.fileCount > 0 || built.imageParts.length > 0) {
      const bits: string[] = [];
      if (built.fileCount > 0) bits.push(`${built.fileCount} file(s)`);
      if (built.imageParts.length > 0) bits.push(`${built.imageParts.length} image(s)`);
      contextSummary = `[Context attached: ${bits.join(", ")}. See the Vault context section for full contents.]`;
    }

    if (built.imageParts.length && messages.length) {
      // Find the last user message and convert it to multimodal.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const userText: string = messageText(messages[i].content);
          const parts: ContentPart[] = [
            { type: "text", text: (contextSummary ? contextSummary + "\n\n" : "") + userText },
            ...built.imageParts,
          ];
          messages[i] = { role: "user", content: parts } as ChatMessage;
          break;
        }
      }
    } else if (contextSummary && messages.length) {
      // Text-only context: prepend the summary to the last user message.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const userText: string = messageText(messages[i].content);
          messages[i] = { role: "user", content: contextSummary + "\n\n" + userText };
          break;
        }
      }
    }

    // Log the final request structure (without full content, for size).
    console.log("[obsidian-chat] buildRequestMessages: sending", {
      messageCount: messages.length,
      roles: messages.map((m) => m.role),
      systemLen: typeof messages[0]?.content === "string" ? messages[0].content.length : 0,
    });

    return messages;
  }

  private async onSend(): Promise<void> {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.plugin.hasCredentials()) {
      new Notice("Set your API key in plugin settings first.");
      return;
    }

    this.inputEl.value = "";
    this.autosizeTextarea();
    this.messages.push({ role: "user", content: text });
    await this.renderMessages();
    await this.saveFile();

    try {
      this.setBusy(true);
      this.abortController = new AbortController();
      const signal = this.abortController.signal;
      const requestMessages = await this.buildRequestMessages();

      const hasImages = requestMessages.some(
        (m) => Array.isArray(m.content) &&
          m.content.some((p) => p.type === "image")
      );
      const model = hasImages && this.plugin.settings.imageModel.trim()
        ? this.plugin.settings.imageModel.trim()
        : this.plugin.settings.model;
      console.log("[obsidian-chat] onSend: using model", model, "(hasImages:", hasImages, ")");

      // Create the assistant message placeholder + streaming DOM element.
      const assistantMsg: ChatMessage = { role: "assistant", content: "" };
      this.messages.push(assistantMsg);
      const streamEls = this.createStreamingElement(assistantMsg);

      // Non-streaming request via requestUrl (bypasses CORS, works everywhere).
      const res = await this.plugin.provider.chat({
        messages: requestMessages,
        model,
        temperature: this.plugin.settings.temperature,
        maxTokens: this.plugin.settings.maxTokens,
        signal,
      });

      if (signal.aborted) {
        // User pressed Stop before the response arrived.
        if (!assistantMsg.content) this.messages.pop();
        await this.renderMessages();
        new Notice("Stopped.");
        return;
      }

      // Set thinking content (if the provider included it).
      if (res.thinking && this.plugin.settings.showThinking) {
        assistantMsg.thinking = res.thinking;
        streamEls.updateThinking(res.thinking);
      }

      // Set the full content.
      assistantMsg.content = res.content;
      this.usage.inputTokens += res.usage.inputTokens;
      this.usage.outputTokens += res.usage.outputTokens;
      this.updateStatus();

      if (this.plugin.settings.streaming && res.content) {
        // Simulated streaming: reveal the text gradually for a typewriter effect.
        await this.simulateStream(res.content, signal, (chunk) => {
          streamEls.updateContent(chunk);
        });
      } else {
        streamEls.updateContent(res.content);
      }

      // Final render: markdown-render the complete response.
      await this.renderMessages();
      await this.saveFile();
      this.updateStatus();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("abort")) {
        new Notice("Stopped.");
        // Remove empty assistant message if nothing was streamed.
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "assistant" && !last.content && !last.thinking) {
          this.messages.pop();
        }
        await this.renderMessages();
        await this.saveFile();
      } else {
        new Notice("AI request failed: " + msg);
        // Remove the empty assistant placeholder.
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          this.messages.pop();
        }
        this.messages.push({
          role: "assistant",
          content: `> ⚠️ Request failed: ${msg}`,
        });
        await this.renderMessages();
        await this.saveFile();
      }
    } finally {
      this.setBusy(false);
      this.abortController = null;
    }
  }

  // ---- simulated streaming ----

  private simulateStream(
    fullText: string,
    signal: AbortSignal,
    onChunk: (revealed: string) => void
  ): Promise<void> {
    // Reveal the text in chunks. Adaptive chunk size so total time stays
    // reasonable regardless of response length (~1-2 seconds).
    const totalFrames = 80;
    const chunkSize = Math.max(1, Math.ceil(fullText.length / totalFrames));
    const delay = 12; // ms per frame
    let pos = 0;
    let revealed = "";

    return new Promise((resolve) => {
      const tick = () => {
        if (signal.aborted || pos >= fullText.length) {
          // Reveal everything remaining on abort or completion.
          onChunk(fullText);
          resolve();
          return;
        }
        revealed = fullText.slice(0, pos + chunkSize);
        pos += chunkSize;
        onChunk(revealed);
        setTimeout(tick, delay);
      };
      tick();
    });
  }

  // ---- streaming DOM ----

  private createStreamingElement(msg: ChatMessage): {
    updateContent: (text: string) => void;
    updateThinking: (text: string) => void;
  } {
    const wrap = this.messagesEl.createDiv({
      cls: "chat-message chat-message-assistant",
    });
    wrap.createDiv({
      cls: "chat-message-role",
      text: "🤖 Assistant",
    });
    const body = wrap.createDiv({ cls: "chat-message-body" });

    // Thinking section (hidden until thinking content arrives).
    let thinkingDetails: HTMLDetailsElement | null = null;
    let thinkingBody: HTMLElement | null = null;

    // Content section: raw text during streaming, markdown-rendered when done.
    const contentEl = body.createDiv({ cls: "chat-message-streaming" });

    // Scroll to bottom as content arrives.
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    return {
      updateContent: (text: string) => {
        // Show raw text during streaming for performance.
        contentEl.setText(text);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      updateThinking: (text: string) => {
        if (!this.plugin.settings.showThinking) return;
        if (!thinkingDetails) {
          thinkingDetails = body.createEl("details", { cls: "ai-thinking" });
          thinkingDetails.open = true; // expanded while streaming
          thinkingDetails.createEl("summary", { text: "💭 Thinking…" });
          thinkingBody = thinkingDetails.createDiv({ cls: "ai-thinking-body" });
          // Insert before content.
          body.insertBefore(thinkingDetails, contentEl);
        }
        if (thinkingBody) {
          thinkingBody.setText(text);
        }
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
    };
  }

  private marginRetries = 0;

  private adjustMobileMargin(): void {
    // Obsidian sets margin-top on .view-content = safe-area + view-header height
    // (e.g. 99px on iPhone). We hide the view-header but KEEP the full offset —
    // the user confirmed this position is correct. We read the value at runtime
    // (with retries, since Obsidian applies it asynchronously) and move it from
    // the margin to padding-top on our root. Adaptive to any device.
    const viewContent = this.contentEl;
    const marginTop = parseFloat(getComputedStyle(viewContent).marginTop) || 0;

    if (marginTop <= 0) {
      // Not applied yet (timing) — retry a few times.
      if (this.marginRetries < 5) {
        this.marginRetries++;
        setTimeout(() => this.adjustMobileMargin(), 200);
      }
      return;
    }

    // Move Obsidian's margin to our root's padding (keeps the same visual
    // position: content sits below the mobile top bar on this device).
    viewContent.style.setProperty("margin-top", "0px", "important");
    this.rootEl.style.paddingTop = marginTop + "px";
    this.rootEl.style.boxSizing = "border-box";
    console.log("[obsidian-chat] adjustMobileMargin: margin", marginTop, "px → padding on root");
  }

  private abortRequest(): void {
    this.abortController?.abort();
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    if (!this.sendBtn) return;
    this.sendBtn.textContent = b ? "Stop" : "Send";
    this.rootEl?.toggleClass("ai-busy", b);
    if (this.inputEl) this.inputEl.disabled = b;
    this.hintEl?.setText(
      b ? "Thinking… (Stop to cancel)" : "⌘/Ctrl+Enter to send"
    );
  }

  // ---- persistence ----

  private deriveTitle(): string {
    const firstUser = this.messages.find((m) => m.role === "user");
    if (firstUser) {
      const t = sanitizeTitle(messageText(firstUser.content).split("\n")[0]);
      if (t) return t.slice(0, 60);
    }
    return "New chat";
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!path) return;
    const parts = path.split("/").filter(Boolean).slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          /* race; ignore */
        }
      }
    }
  }

  private async newFilePath(title: string): Promise<string> {
    const folder = this.plugin.settings.chatFolder.replace(/\/+$/, "") || "AI Chats";
    const safe = sanitizeTitle(title).slice(0, 60).trim() || "chat";
    await this.ensureFolder(folder);
    const base = `${folder}/${nowStamp()} ${safe}`;
    let path = `${base}.md`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${base} (${i}).md`;
      i++;
    }
    return path;
  }

  private async saveFile(): Promise<void> {
    if (!this.messages.length) return;
    const meta: ChatMetadata = {
      title: this.deriveTitle(),
      created: this.created,
      updated: new Date().toISOString(),
      provider: this.plugin.settings.provider,
      model: this.plugin.settings.model,
      status: "active",
      summary: "",
      context: this.context,
      usage: this.usage,
    };
    const body = serializeMessages(this.messages);
    const content = serializeChatFile(meta, body);
    try {
      if (this.file) {
        await this.app.vault.modify(this.file, content);
      } else {
        const path = await this.newFilePath(meta.title);
        this.file = await this.app.vault.create(path, content);
      }
    } catch (e) {
      new Notice("Failed to save chat: " + (e as Error).message);
    }
    this.updateStatus();
  }

  // ---- status bar ----

  private updateStatus(): void {
    if (!this.aiTitleEl) return;
    // Don't clobber the title while the user is editing it.
    if (document.activeElement !== this.aiTitleEl) {
      this.aiTitleEl.setText(this.file ? this.file.basename : "New AI chat");
    }
    const inT = this.usage.inputTokens;
    const outT = this.usage.outputTokens;
    const parts: string[] = [];
    parts.push(`In ${inT} · Out ${outT} tokens`);
    if (this.contextTokens > 0) {
      parts.push(`Context ~${this.contextTokens}`);
    }
    parts.push(this.plugin.settings.provider + "/" + this.plugin.settings.model);
    // If images are attached and an image model is configured, show it too.
    if (this.contextImageCount > 0 && this.plugin.settings.imageModel.trim()) {
      parts.push("img→" + this.plugin.settings.imageModel.trim());
    }
    this.usageEl.setText(parts.join(" · "));
  }

  private async onTitleEdited(): Promise<void> {
    const newTitle = this.aiTitleEl.getText().trim();
    if (!newTitle) {
      // Revert to current title if emptied.
      this.aiTitleEl.setText(this.file ? this.file.basename : "New AI chat");
      return;
    }
    if (this.file && newTitle !== this.file.basename) {
      // Rename the file.
      const folder = this.file.parent?.path ?? "";
      const safe = sanitizeTitle(newTitle).slice(0, 100) || "chat";
      const newPath = folder ? `${folder}/${safe}.md` : `${safe}.md`;
      // Avoid collision
      let finalPath = newPath;
      let i = 1;
      while (this.app.vault.getAbstractFileByPath(finalPath) && finalPath !== this.file.path) {
        finalPath = folder ? `${folder}/${safe} (${i}).md` : `${safe} (${i}).md`;
        i++;
      }
      try {
        await this.app.fileManager.renameFile(this.file, finalPath);
        this.file = this.app.vault.getAbstractFileByPath(finalPath) as TFile;
      } catch (e) {
        new Notice("Failed to rename: " + (e as Error).message);
        this.aiTitleEl.setText(this.file.basename);
      }
    }
    this.updateStatus();
  }

  private autosizeTextarea(): void {
    const el = this.inputEl;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(220, el.scrollHeight) + "px";
  }
}
