import {
  ItemView,
  Notice,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type ObsidianAIPlugin from "../main";
import type { ChatView } from "./ChatView";
import type { ChatContext } from "../types";
import { buildContext } from "../context/builder";
import { estimateTokens } from "../chat/tokenEstimate";
import { FileSuggestModal, FolderSuggestModal } from "../context/picker";

export const CONTEXT_VIEW_TYPE = "obsidian-chat-context";

export class ContextView extends ItemView {
  plugin: ObsidianAIPlugin;
  private listEl!: HTMLElement;
  private summaryEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CONTEXT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Context";
  }

  getIcon(): string {
    return "paperclip";
  }

  async onOpen(): Promise<void> {
    this.contentEl.style.position = "relative";

    const root = this.contentEl.createDiv({ cls: "obsidian-chat-context" });

    // Same mobile margin adjustment as ChatView — see comment there.
    setTimeout(() => this.adjustMobileMargin(), 100);

    // Header with action buttons
    const header = root.createDiv({ cls: "ai-ctx-header" });
    header.createEl("h2", { text: "Context" });

    const btnRow = header.createDiv({ cls: "ai-ctx-buttons" });
    new Setting(btnRow)
      .addButton((b) =>
        b
          .setIcon("file-text")
          .setButtonText("Add file")
          .onClick(() => this.addFile())
      )
      .addButton((b) =>
        b
          .setIcon("folder")
          .setButtonText("Add folder")
          .onClick(() => this.addFolder())
      )
      .addButton((b) =>
        b
          .setIcon("x")
          .setButtonText("Clear all")
          .setWarning()
          .onClick(() => this.clearContext())
      )
      .settingEl.style.setProperty("padding", "0");

    // Summary (token estimate + file count)
    this.summaryEl = root.createDiv({ cls: "ai-ctx-summary" });

    // File list
    this.listEl = root.createDiv({ cls: "ai-ctx-list" });

    await this.refresh();
  }

  async onClose(): Promise<void> {}

  async onOpenFile(): Promise<void> {}

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {
    await this.refresh();
  }

  // Get the active chat's context (shared state with ChatView)
  private marginRetries = 0;
  private adjustMobileMargin(): void {
    const viewContent = this.contentEl;
    const marginTop = parseFloat(getComputedStyle(viewContent).marginTop) || 0;
    if (marginTop <= 0) {
      if (this.marginRetries < 5) {
        this.marginRetries++;
        setTimeout(() => this.adjustMobileMargin(), 200);
      }
      return;
    }
    viewContent.style.setProperty("margin-top", "0px", "important");
    const root = this.contentEl.querySelector(".obsidian-chat-context") as HTMLElement | null;
    if (root) {
      root.style.paddingTop = marginTop + "px";
      root.style.boxSizing = "border-box";
    }
  }

  private getChatContext(): ChatContext | null {
    const chatView = this.plugin.getActiveChatView();
    if (!chatView) return null;
    return chatView.context;
  }

  // Ensure there is an active chat. If none, open a new one. Returns the
  // ChatView (or null if opening failed). This lets the user add context
  // immediately without manually opening a chat first.
  private async ensureChat(): Promise<ChatView | null> {
    let chatView = this.plugin.getActiveChatView();
    if (chatView) return chatView;
    // No active chat — open a new one.
    await this.plugin.openNewChat();
    chatView = this.plugin.getActiveChatView();
    return chatView;
  }

  async refresh(): Promise<void> {
    if (!this.listEl) return;
    this.listEl.empty();
    this.summaryEl.empty();

    // Auto-open a chat if none is active, so the user can add context right away.
    if (!this.plugin.getActiveChatView()) {
      this.listEl.createDiv({
        cls: "ai-ctx-empty",
        text: "Opening a new chat…",
      });
      await this.plugin.openNewChat();
    }

    const ctx = this.getChatContext();
    if (!ctx) {
      this.listEl.createDiv({
        cls: "ai-ctx-empty",
        text: "No active chat. Open a chat from the chat view, then manage its context here.",
      });
      return;
    }

    const allPaths = [...ctx.files, ...ctx.folders];
    if (allPaths.length === 0) {
      this.listEl.createDiv({
        cls: "ai-ctx-empty",
        text: "No files attached. Use \"Add file\" or \"Add folder\" above.",
      });
      this.summaryEl.setText("0 files · ~0 tokens");
      return;
    }

    // Build list items
    for (const path of ctx.files) {
      this.createFileItem(path, "file");
    }
    for (const path of ctx.folders) {
      this.createFileItem(path, "folder");
    }

    // Update token estimate
    await this.updateSummary();
  }

  private createFileItem(path: string, kind: "file" | "folder"): void {
    const item = this.listEl.createDiv({ cls: `ai-ctx-file is-${kind}` });

    // Icon
    const icon = item.createDiv({ cls: "ai-ctx-file-icon" });
    setIcon(icon, kind === "folder" ? "folder" : "file-text");

    // Name + path
    const info = item.createDiv({ cls: "ai-ctx-file-info" });
    const name = path.replace(/\/+$/, "").split("/").pop() || path;
    info.createDiv({ cls: "ai-ctx-file-name", text: name });
    info.createDiv({ cls: "ai-ctx-file-path", text: path });

    // File size (for files)
    if (kind === "file") {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const sizeKB = (file.stat.size / 1024).toFixed(0);
        info.createDiv({
          cls: "ai-ctx-file-size",
          text: `${sizeKB} KB · ${file.extension}`,
        });
      }
    }

    // Remove button
    const rm = item.createDiv({ cls: "ai-ctx-file-remove" });
    setIcon(rm, "x");
    rm.addEventListener("click", async () => {
      await this.removeContextItem(kind, path);
    });
  }

  private async updateSummary(): Promise<void> {
    const ctx = this.getChatContext();
    if (!ctx) {
      this.summaryEl.setText("0 files · ~0 tokens");
      return;
    }
    const count = ctx.files.length + ctx.folders.length;
    if (count === 0) {
      this.summaryEl.setText("0 files · ~0 tokens");
      return;
    }
    // Estimate tokens by building context
    try {
      const built = await buildContext(
        this.app,
        ctx,
        this.plugin.contextOptions
      );
      const parts: string[] = [`${built.fileCount} file(s)`];
      if (built.imageParts.length > 0) {
        parts.push(`${built.imageParts.length} image(s)`);
      }
      parts.push(`~${built.tokens} tokens`);
      if (built.skippedCount > 0) {
        parts.push(`${built.skippedCount} skipped`);
      }
      this.summaryEl.setText(parts.join(" · "));
      if (built.notes.length) {
        this.summaryEl.setAttribute("title", built.notes.join("\n"));
      }
    } catch {
      this.summaryEl.setText(`${count} items`);
    }
  }

  // ---- context actions (delegated to active ChatView) ----

  async addFile(): Promise<void> {
    const chatView = await this.ensureChat();
    if (!chatView) {
      new Notice("Could not open a chat.");
      return;
    }
    new FileSuggestModal(this.app, async (f) => {
      if (!chatView.context.files.includes(f.path)) {
        chatView.context.files.push(f.path);
        await chatView.onContextChanged();
        await this.refresh();
      }
    }).open();
  }

  async addFolder(): Promise<void> {
    const chatView = await this.ensureChat();
    if (!chatView) {
      new Notice("Could not open a chat.");
      return;
    }
    new FolderSuggestModal(this.app, async (folder) => {
      const opts = this.plugin.contextOptions;
      const prefix = folder.path === "/" ? "" : folder.path + "/";
      const allFiles = this.app.vault.getFiles();
      const files = allFiles.filter(
        (f) =>
          f.path.startsWith(prefix) &&
          opts.extensions.has(f.extension.toLowerCase())
      );
      let added = 0;
      for (const file of files) {
        if (!chatView.context.files.includes(file.path)) {
          chatView.context.files.push(file.path);
          added++;
        }
      }
      if (added === 0) {
        new Notice(`No attachable files found in "${folder.path}"`);
      } else {
        new Notice(
          `Added ${added} file${added === 1 ? "" : "s"} from "${folder.path}"`
        );
      }
      await chatView.onContextChanged();
      await this.refresh();
    }).open();
  }

  async clearContext(): Promise<void> {
    const chatView = await this.ensureChat();
    if (!chatView) {
      new Notice("Could not open a chat.");
      return;
    }
    chatView.context = { files: [], folders: [] };
    await chatView.onContextChanged();
    await this.refresh();
  }

  private async removeContextItem(
    kind: "file" | "folder",
    path: string
  ): Promise<void> {
    const chatView = this.plugin.getActiveChatView();
    if (!chatView) return;
    if (kind === "file") {
      chatView.context.files = chatView.context.files.filter(
        (p) => p !== path
      );
    } else {
      chatView.context.folders = chatView.context.folders.filter(
        (p) => p !== path
      );
    }
    await chatView.onContextChanged();
    await this.refresh();
  }
}
