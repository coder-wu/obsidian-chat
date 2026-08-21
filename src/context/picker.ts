// Vault pickers built on Obsidian's FuzzySuggestModal.

import { App, FuzzySuggestModal, TFile, TFolder } from "obsidian";
import { DEFAULT_CONTEXT_OPTIONS } from "./builder";

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= 0) return "";
  return path.slice(idx + 1).toLowerCase();
}

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onPick: (file: TFile) => void;

  constructor(app: App, onPick: (file: TFile) => void) {
    super(app);
    this.onPick = onPick;
    this.files = app.vault.getFiles().filter((f) =>
      DEFAULT_CONTEXT_OPTIONS.extensions.has(extOf(f.path))
    );
    this.setPlaceholder("Select a file to attach as context");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private folders: TFolder[];
  private onPick: (folder: TFolder) => void;

  constructor(app: App, onPick: (folder: TFolder) => void) {
    super(app);
    this.onPick = onPick;
    this.folders = app.vault.getAllLoadedFiles().filter(
      (f): f is TFolder => f instanceof TFolder
    );
    this.setPlaceholder("Select a folder to attach as context");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path + "/";
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder);
  }
}

export class ChatFileSuggestModal extends FuzzySuggestModal<TFile> {
  private chats: TFile[];
  private onPick: (file: TFile) => void;

  constructor(app: App, chatFolder: string, onPick: (file: TFile) => void) {
    super(app);
    this.onPick = onPick;
    const prefix = chatFolder.replace(/\/+$/, "") + "/";
    this.chats = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
    this.setPlaceholder("Select a chat to resume");
  }

  getItems(): TFile[] {
    return this.chats;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
