import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  ObsidianAISettingTab,
  type ObsidianAISettings,
} from "./settings";
import { getProvider } from "./providers";
import type { AIProvider } from "./types";
import { CHAT_VIEW_TYPE, ChatView } from "./ui/ChatView";
import { CONTEXT_VIEW_TYPE, ContextView } from "./ui/ContextView";
import { ChatFileSuggestModal } from "./context/picker";
import type { BuildContextOptions } from "./context/builder";

export default class ObsidianAIPlugin extends Plugin {
  declare settings: ObsidianAISettings;
  provider!: AIProvider;
  contextOptions!: BuildContextOptions;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildProvider();
    this.rebuildContextOptions();

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(CONTEXT_VIEW_TYPE, (leaf) => new ContextView(leaf, this));

    // Startup cleanup
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(CONTEXT_VIEW_TYPE);

    this.addRibbonIcon("message-square", "New AI chat", () => this.openNewChat());

    this.addCommand({
      id: "new-chat",
      name: "New AI chat",
      callback: () => this.openNewChat(),
    });

    this.addCommand({
      id: "resume-chat",
      name: "Resume AI chat",
      callback: () => this.openResumePicker(),
    });

    this.addCommand({
      id: "attach-file",
      name: "Attach file to current chat",
      checkCallback: (checking) => {
        const view = this.activeChatView();
        if (!view) return false;
        if (checking) return true;
        view.addFile();
      },
    });

    this.addCommand({
      id: "attach-folder",
      name: "Attach folder to current chat",
      checkCallback: (checking) => {
        const view = this.activeChatView();
        if (!view) return false;
        if (checking) return true;
        view.addFolder();
      },
    });

    this.addCommand({
      id: "clear-context",
      name: "Clear context of current chat",
      checkCallback: (checking) => {
        const view = this.activeChatView();
        if (!view) return false;
        if (checking) return true;
        view.clearContext();
      },
    });

    this.addCommand({
      id: "open-context",
      name: "Open context manager",
      callback: () => this.openContextView(),
    });

    this.addSettingTab(new ObsidianAISettingTab(this.app, this));
  }

  // ---- settings ----

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- provider / context options ----

  rebuildProvider(): void {
    this.provider = getProvider(this.settings.provider, {
      openaiApiKey: this.settings.openaiApiKey,
      openaiBaseURL: this.settings.openaiBaseURL,
      anthropicApiKey: this.settings.anthropicApiKey,
      anthropicBaseURL: this.settings.anthropicBaseURL,
    });
  }

  rebuildContextOptions(): void {
    const extensions = new Set(
      this.settings.fileExtensions
        .split(",")
        .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean)
    );
    this.contextOptions = {
      maxFileBytes: this.settings.maxFileKB * 1024,
      maxImageBytes: this.settings.maxImageMB * 1024 * 1024,
      extensions,
    };
  }

  hasCredentials(): boolean {
    if (this.settings.provider === "openai") return !!this.settings.openaiApiKey;
    return !!this.settings.anthropicApiKey;
  }

  // ---- view helpers ----

  // Public so ContextView can access the active chat's context.
  getActiveChatView(): ChatView | null {
    return this.app.workspace.getActiveViewOfType(ChatView) as ChatView | null;
  }

  private activeChatView(): ChatView | null {
    return this.getActiveChatView();
  }

  // Always open a FRESH chat leaf. Earlier crashes can leave a half-loaded
  // ("zombie") chat leaf saved in the workspace; reusing it makes core's
  // view.load() throw. We detach any existing chat leaves first, then create a
  // brand-new leaf, so the view is constructed cleanly every time.
  private async getChatLeaf(
    state: Record<string, unknown> = {}
  ): Promise<WorkspaceLeaf> {
    // Reuse an existing healthy chat leaf if present; otherwise create a new
    // tab. (Startup already detached zombies via detachLeavesOfType in onload.)
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf("tab");
    console.log("[obsidian-chat] getChatLeaf: leaf", existing.length ? "reused" : "new");
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, state, active: true });
    console.log("[obsidian-chat] getChatLeaf: setViewState done");
    const v = leaf.view as any;
    console.log("[obsidian-chat] getChatLeaf: view is ChatView?", v instanceof ChatView,
      "getViewType=", v?.getViewType?.(),
      "contentEl?", !!v?.contentEl);
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async openNewChat(): Promise<void> {
    if (!this.hasCredentials()) {
      new Notice("Set your API key in Obsidian Chat settings first.");
    }
    try {
      console.log("[obsidian-chat] openNewChat: start");
      // Empty state -> ChatView.applyState starts a fresh chat.
      const leaf = await this.getChatLeaf({});
      console.log("[obsidian-chat] openNewChat: leaf ready, view=", leaf.view);
    } catch (e) {
      console.error("[obsidian-chat] openNewChat failed:", e);
      new Notice("Failed to open AI chat: " + (e as Error).message);
    }
  }

  openResumePicker(): void {
    new ChatFileSuggestModal(this.app, this.settings.chatFolder, async (file) => {
      try {
        // Passing the file path in state lets the view load it once ready.
        await this.getChatLeaf({ file: file.path });
      } catch (e) {
        console.error("[obsidian-chat] resume failed:", e);
        new Notice("Failed to open chat: " + (e as Error).message);
      }
    }).open();
  }

  async openContextView(): Promise<void> {
    try {
      // Reuse existing context leaf, or open a new one in a split.
      const existing = this.app.workspace.getLeavesOfType(CONTEXT_VIEW_TYPE);
      let leaf: WorkspaceLeaf;
      if (existing.length) {
        leaf = existing[0];
      } else {
        leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("split");
        await leaf.setViewState({ type: CONTEXT_VIEW_TYPE, state: {} });
      }
      this.app.workspace.revealLeaf(leaf);
      // Refresh the context view to show current state.
      const view = leaf.view;
      if (view instanceof ContextView) {
        await view.refresh();
      }
    } catch (e) {
      console.error("[obsidian-chat] openContextView failed:", e);
      new Notice("Failed to open context: " + (e as Error).message);
    }
  }
}
