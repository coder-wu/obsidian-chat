import OpenAI from "openai";
import { obsidianFetch, streamingFetch } from "./fetchAdapter";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ContentPart,
  StreamCallbacks,
} from "../types";

const FALLBACK_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o1-mini"];

function toOpenAIContent(
  content: string | ContentPart[]
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    };
  });
}

function buildRequestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: toOpenAIContent(m.content),
    })),
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  return body;
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  private client: OpenAI;
  private streamClient: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    const opts = {
      apiKey,
      baseURL: baseURL || undefined,
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    };
    this.client = new OpenAI({
      ...opts,
      fetch: obsidianFetch as unknown as typeof fetch,
    });
    // Separate client with native fetch for streaming (ReadableStream support).
    this.streamClient = new OpenAI({
      ...opts,
      fetch: streamingFetch as unknown as typeof fetch,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const requestBody = buildRequestBody(req, false);

    const logBody = JSON.parse(JSON.stringify(requestBody));
    if (Array.isArray(logBody.messages)) {
      logBody.messages = logBody.messages.map((m: any) => ({
        role: m.role,
        contentType: typeof m.content === "string" ? "string" : "array",
        contentLen: typeof m.content === "string"
          ? m.content.length
          : Array.isArray(m.content) ? m.content.length : 0,
      }));
    }
    console.log("[obsidian-chat] OpenAI chat request:", logBody);

    const res = await this.client.chat.completions.create(
      requestBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: req.signal }
    );
    const choice = res.choices[0];
    const message = choice?.message as any;
    return {
      content: message?.content ?? "",
      // DeepSeek and some compatible providers include reasoning_content even
      // in non-streaming responses.
      thinking: message?.reasoning_content ?? undefined,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  }

  async chatStream(
    req: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<ChatResponse> {
    const requestBody = buildRequestBody(req, true);

    const stream = await this.streamClient.chat.completions.create(
      requestBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: req.signal }
    );

    let content = "";
    let thinking = "";
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta as any;

      // Regular content
      if (delta?.content) {
        content += delta.content;
        callbacks.onContent(delta.content);
      }

      // Reasoning/thinking content (DeepSeek and some OpenAI-compatible providers)
      if (delta?.reasoning_content) {
        thinking += delta.reasoning_content;
        callbacks.onThinking?.(delta.reasoning_content);
      }

      // Usage (sent in the last chunk when stream_options.include_usage is true)
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
        callbacks.onUsage?.(usage);
      }
    }

    return { content, thinking: thinking || undefined, usage };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.client.models.list();
      const ids = res.data.map((m) => m.id).sort();
      return ids.length ? ids : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  }
}
