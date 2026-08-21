// Core types shared across the plugin.

export type ProviderId = "openai" | "anthropic";

// Multimodal content parts.
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mediaType: string;
  data: string; // base64-encoded
}

export interface DocumentPart {
  type: "document";
  mediaType: string;
  data: string; // base64-encoded
}

export type ContentPart = TextPart | ImagePart | DocumentPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
  // Reasoning/thinking content from models that support it (DeepSeek, etc.).
  // Stored separately so it can be displayed in a collapsible section.
  thinking?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  usage: ChatUsage;
}

// Callbacks for streaming responses.
export interface StreamCallbacks {
  onContent: (text: string) => void;
  onThinking?: (text: string) => void;
  onUsage?: (usage: ChatUsage) => void;
}

export interface AIProvider {
  readonly name: ProviderId;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

export interface ChatContext {
  files: string[];
  folders: string[];
}

export interface ChatMetadata {
  title: string;
  created: string;
  updated: string;
  provider: string;
  model: string;
  status: "active" | "archived";
  summary: string;
  context: ChatContext;
  usage: ChatUsage;
}
