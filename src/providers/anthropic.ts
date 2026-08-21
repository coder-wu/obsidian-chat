import Anthropic from "@anthropic-ai/sdk";
import { obsidianFetch, streamingFetch } from "./fetchAdapter";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ContentPart,
  StreamCallbacks,
} from "../types";

const FALLBACK_MODELS = [
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-opus-latest",
];

function toAnthropicContent(
  content: string | ContentPart[]
): string | any[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType as
            | "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: part.data,
        },
      };
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: part.mediaType as "application/pdf",
        data: part.data,
      },
    };
  });
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;
  private streamClient: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    const opts = {
      apiKey,
      baseURL: baseURL || undefined,
      dangerouslyAllowBrowser: true,
    };
    this.client = new Anthropic({
      ...opts,
      fetch: obsidianFetch as unknown as typeof fetch,
    });
    this.streamClient = new Anthropic({
      ...opts,
      fetch: streamingFetch as unknown as typeof fetch,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: toAnthropicContent(m.content),
      }));

    const res = await this.client.messages.create(
      {
        model: req.model,
        system: system || undefined,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
      },
      { signal: req.signal }
    );

    const content = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      content,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
    };
  }

  async chatStream(
    req: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<ChatResponse> {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: toAnthropicContent(m.content),
      }));

    const stream = await this.streamClient.messages.stream(
      {
        model: req.model,
        system: system || undefined,
        messages,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
      },
      { signal: req.signal }
    );

    let content = "";
    let thinking = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        const delta = event.delta as any;
        if (delta.type === "text_delta") {
          content += delta.text;
          callbacks.onContent(delta.text);
        } else if (delta.type === "thinking_delta") {
          thinking += delta.thinking;
          callbacks.onThinking?.(delta.thinking);
        }
      } else if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
      }
    }

    const usage = { inputTokens, outputTokens };
    callbacks.onUsage?.(usage);

    return { content, thinking: thinking || undefined, usage };
  }

  async listModels(): Promise<string[]> {
    return FALLBACK_MODELS;
  }
}
