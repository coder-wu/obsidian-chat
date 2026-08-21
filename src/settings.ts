import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianAIPlugin from "./main";
import type { ProviderId } from "./types";

export interface ObsidianAISettings {
  provider: ProviderId;
  openaiApiKey: string;
  openaiBaseURL: string;
  anthropicApiKey: string;
  anthropicBaseURL: string;
  model: string;
  imageModel: string; // model used when images are attached; empty = use `model`
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  chatFolder: string;
  fileExtensions: string;
  maxFileKB: number;
  maxImageMB: number;
  streaming: boolean;
  showThinking: boolean;
}

export const DEFAULT_SETTINGS: ObsidianAISettings = {
  provider: "openai",
  openaiApiKey: "",
  openaiBaseURL: "",
  anthropicApiKey: "",
  anthropicBaseURL: "",
  model: "gpt-4o-mini",
  imageModel: "gpt-4o", // vision-capable default for image requests
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt:
    "You are a helpful assistant integrated into the Obsidian note-taking app. " +
    "The user may attach vault files and folders as context — these appear in a " +
    "'# Vault context' section in the system message. Always read and use that " +
    "context when answering. If files are attached, you HAVE access to their " +
    "full contents — do not claim you cannot see them. " +
    "Prefer concise, well-structured markdown answers.",
  chatFolder: "AI Chats",
  fileExtensions:
    "md,txt,markdown,csv,json,yaml,yml,js,ts,tsx,jsx,py,rb,go,rs,java,c,cpp,h,hpp,sh,bash,zsh,html,css,xml,toml,ini,env,log,sql,png,jpg,jpeg,gif,webp,bmp,pdf",
  maxFileKB: 512,
  maxImageMB: 20,
  streaming: true,
  showThinking: true,
};

class ModelSuggestModal extends FuzzySuggestModal<string> {
  private models: string[];
  private onPick: (m: string) => void;

  constructor(app: App, models: string[], onPick: (m: string) => void) {
    super(app);
    this.models = models;
    this.onPick = onPick;
    this.setPlaceholder("Pick a model");
  }

  getItems(): string[] {
    return this.models;
  }

  getItemText(m: string): string {
    return m;
  }

  onChooseItem(m: string): void {
    this.onPick(m);
  }
}

export class ObsidianAISettingTab extends PluginSettingTab {
  plugin: ObsidianAIPlugin;

  constructor(app: App, plugin: ObsidianAIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Chat" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which cloud provider to use for chat.")
      .addDropdown((dd) =>
        dd
          .addOption("openai", "OpenAI")
          .addOption("anthropic", "Anthropic")
          .setValue(this.plugin.settings.provider)
          .onChange(async (v) => {
            this.plugin.settings.provider = v as ProviderId;
            await this.plugin.saveSettings();
            this.plugin.rebuildProvider();
            this.display();
          })
      );

    if (this.plugin.settings.provider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API key")
        .addText((t) => {
          t.inputEl.type = "password";
          t.inputEl.placeholder = "sk-...";
          t.setValue(this.plugin.settings.openaiApiKey).onChange(async (v) => {
            this.plugin.settings.openaiApiKey = v;
            await this.plugin.saveSettings();
            this.plugin.rebuildProvider();
          });
        });
      new Setting(containerEl)
        .setName("OpenAI base URL")
        .setDesc("Optional. For OpenAI-compatible endpoints (e.g. Azure, local proxies).")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.openaiBaseURL)
            .setPlaceholder("https://api.openai.com/v1")
            .onChange(async (v) => {
              this.plugin.settings.openaiBaseURL = v;
              await this.plugin.saveSettings();
              this.plugin.rebuildProvider();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .addText((t) => {
          t.inputEl.type = "password";
          t.inputEl.placeholder = "sk-ant-...";
          t.setValue(this.plugin.settings.anthropicApiKey).onChange(async (v) => {
            this.plugin.settings.anthropicApiKey = v;
            await this.plugin.saveSettings();
            this.plugin.rebuildProvider();
          });
        });
      new Setting(containerEl)
        .setName("Anthropic base URL")
        .setDesc("Optional. Custom endpoint for Anthropic-compatible services.")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.anthropicBaseURL)
            .setPlaceholder("https://api.anthropic.com")
            .onChange(async (v) => {
              this.plugin.settings.anthropicBaseURL = v;
              await this.plugin.saveSettings();
              this.plugin.rebuildProvider();
            })
        );
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model name sent to the provider.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((b) =>
        b
          .setButtonText("Refresh")
          .setTooltip("Fetch available models from the provider")
          .onClick(async () => {
            new Notice("Fetching models…");
            try {
              const models = await this.plugin.provider.listModels();
              new ModelSuggestModal(this.app, models, async (m) => {
                this.plugin.settings.model = m;
                await this.plugin.saveSettings();
                this.display();
              }).open();
            } catch (e) {
              new Notice("Failed to fetch models: " + (e as Error).message);
            }
          })
      );

    new Setting(containerEl)
      .setName("Image model")
      .setDesc("Model used when images are attached as context. Must support vision (e.g. gpt-4o, gpt-4o-mini). Leave empty to always use the main model.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.imageModel)
          .setPlaceholder("(same as model)")
          .onChange(async (v) => {
            this.plugin.settings.imageModel = v.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((b) =>
        b
          .setButtonText("Refresh")
          .setTooltip("Fetch available models from the provider")
          .onClick(async () => {
            new Notice("Fetching models…");
            try {
              const models = await this.plugin.provider.listModels();
              new ModelSuggestModal(this.app, models, async (m) => {
                this.plugin.settings.imageModel = m;
                await this.plugin.saveSettings();
                this.display();
              }).open();
            } catch (e) {
              new Notice("Failed to fetch models: " + (e as Error).message);
            }
          })
      );

    new Setting(containerEl)
      .setName("Streaming output")
      .setDesc("Show responses as they are generated (typewriter effect). Uses native fetch which may not work on all mobile setups — disable if you get CORS errors.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.streaming)
          .onChange(async (v) => {
            this.plugin.settings.streaming = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show thinking")
      .setDesc("Display the model's reasoning/thinking content in a collapsible section above the response (supported by DeepSeek and some other models).")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.showThinking)
          .onChange(async (v) => {
            this.plugin.settings.showThinking = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Sampling temperature (0–2).")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.temperature))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n)) {
              this.plugin.settings.temperature = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Maximum tokens to generate per response.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n)) {
              this.plugin.settings.maxTokens = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Prepended to every chat as the system message.")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Chat folder")
      .setDesc("Where chat markdown files are saved.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.chatFolder)
          .onChange(async (v) => {
            this.plugin.settings.chatFolder = v.trim() || "AI Chats";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Context file extensions")
      .setDesc("Comma-separated. Only files with these extensions are attached (folders include a file tree regardless).")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.fileExtensions).onChange(async (v) => {
          this.plugin.settings.fileExtensions = v;
          await this.plugin.saveSettings();
          this.plugin.rebuildContextOptions();
        });
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Max text file size (KB)")
      .setDesc("Text files larger than this are skipped when attaching context.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.maxFileKB))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxFileKB = n;
              await this.plugin.saveSettings();
              this.plugin.rebuildContextOptions();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max image size (MB)")
      .setDesc("Images larger than this are skipped. OpenAI accepts up to 20 MB.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.maxImageMB))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxImageMB = n;
              await this.plugin.saveSettings();
              this.plugin.rebuildContextOptions();
            }
          })
      );
  }
}
