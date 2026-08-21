// Wraps Obsidian's `requestUrl` as a standard `fetch` returning a `Response`.
//
// Why: the official AI SDKs accept a custom `fetch`. Obsidian's `requestUrl`
// works on mobile and bypasses CORS, while the webview's global `fetch` does not
// reliably do either.
//
// Non-streaming only: `requestUrl` returns the full body at once.

import { requestUrl } from "obsidian";

function toUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// Header names Chromium's net stack treats as restricted/forbidden. Setting
// these manually via requestUrl -> Electron net.request throws
// ERR_INVALID_ARGUMENT because Chromium computes them from the request itself.
// The OpenAI SDK pre-sets `content-length` (fine for Node http, breaks here), so
// we must strip it and let Electron compute it from the body.
const RESTRICTED_HEADERS = new Set([
  "content-length",
  "content-type", // handled via requestUrl's `contentType` param instead
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
  "expect",
]);

// Convert any HeadersInit to a clean Record<string, string>, dropping entries
// with null/undefined values AND stripping restricted headers. requestUrl
// (Electron net.request) throws ERR_INVALID_ARGUMENT if a header value is
// null/undefined, and the OpenAI SDK routinely includes optional headers that
// are undefined when unset.
function cleanHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  const raw: Array<[string, string]> = [];
  if (headers instanceof Headers) {
    headers.forEach((v, k) => raw.push([k, v]));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) raw.push([k, v]);
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      raw.push([k, String(v)]);
    }
  }

  for (const [k, v] of raw) {
    if (v == null || v === undefined) continue; // skip null/undefined values
    if (RESTRICTED_HEADERS.has(k.toLowerCase())) continue; // strip restricted
    out[k] = String(v);
  }
  return out;
}

export async function obsidianFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = toUrl(input);
  const method = init?.method ?? "GET";

  // Capture Content-Type from the RAW headers before cleanHeaders strips it
  // (it's restricted — must go via requestUrl's `contentType` param, not headers).
  let contentType: string | undefined;
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      contentType = init.headers.get("content-type") ?? undefined;
    } else if (Array.isArray(init.headers)) {
      const found = init.headers.find(([k]) => k.toLowerCase() === "content-type");
      contentType = found ? found[1] : undefined;
    } else {
      const h = init.headers as Record<string, unknown>;
      const key = Object.keys(h).find((k) => k.toLowerCase() === "content-type");
      contentType = key ? String(h[key]) : undefined;
    }
  }

  const headers = cleanHeaders(init?.headers);

  let body: string | ArrayBuffer | undefined = undefined;
  if (init?.body != null) {
    if (typeof init.body === "string") {
      body = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      body = init.body;
    } else if (ArrayBuffer.isView(init.body)) {
      // Re-slice to the view's exact region (the underlying buffer may be larger).
      const view = init.body as ArrayBufferView;
      body = new Uint8Array(
        view.buffer,
        view.byteOffset,
        view.byteLength
      ).slice().buffer;
    } else {
      // Objects/other: stringify so requestUrl gets a valid string.
      body = JSON.stringify(init.body);
    }
  }

  let res;
  try {
    res = await requestUrl({
      url,
      method,
      headers,
      contentType,
      body,
      throw: false,
    });
  } catch (e) {
    console.error("[obsidian-chat] requestUrl threw:", {
      url,
      method,
      contentType,
      headerKeys: Object.keys(headers),
      bodyType: typeof body,
      bodyLen: body ? (typeof body === "string" ? body.length : body.byteLength) : 0,
      error: e,
    });
    throw e;
  }

  if (res.status >= 400) {
    console.warn("[obsidian-chat] HTTP error response:", {
      url,
      status: res.status,
      body: res.text?.slice(0, 1000),
    });

    // Some OpenAI-compatible providers return a non-standard body on error
    // (e.g. a completion object with finish_reason:null instead of an error
    // object). Build a proper error Response with a JSON error body so the
    // SDK surfaces a meaningful message instead of a confusing empty result.
    let errorBody: string;
    try {
      const parsed = JSON.parse(res.text);
      // Check if it looks like a non-standard response (no error field).
      if (parsed.error) {
        errorBody = res.text; // already has an error field
      } else if (parsed.choices && parsed.choices[0]?.finish_reason === null) {
        // Provider returned a 400 with a completion-like body — fabricate an
        // error message from what we can see.
        errorBody = JSON.stringify({
          error: {
            message: `Provider returned status ${res.status} with an empty response (finish_reason: null). ` +
              `This may mean: the context is too long, the model doesn't support some parameters, ` +
              `or the model doesn't support multimodal content. Check console for the full request body.`,
            type: "provider_error",
            code: res.status,
          },
        });
      } else {
        errorBody = res.text;
      }
    } catch {
      errorBody = res.text;
    }
    return new Response(errorBody, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(res.text, {
    status: res.status,
    headers: res.headers ?? undefined,
  });
}

// ---- Streaming fetch ----
// Uses native `fetch` (not requestUrl) because only native fetch returns a
// Response with a real ReadableStream body, which the SDKs need for streaming.
// On desktop (Electron) CORS is relaxed. On mobile it may fail — the caller
// should fall back to non-streaming chat() on error.
//
// Bonus: native fetch respects AbortSignal, so the Stop button truly cancels.

function cleanHeadersBasic(headers: HeadersInit | undefined): Record<string, string> {
  // Same as cleanHeaders but does NOT strip restricted headers — native fetch
  // handles them gracefully (silently ignores forbidden ones like Content-Length).
  // We keep Content-Type because fetch needs it.
  const out: Record<string, string> = {};
  if (!headers) return out;
  const raw: Array<[string, string]> = [];
  if (headers instanceof Headers) {
    headers.forEach((v, k) => raw.push([k, v]));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) raw.push([k, v]);
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      raw.push([k, String(v)]);
    }
  }
  for (const [k, v] of raw) {
    if (v == null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

export async function streamingFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = toUrl(input);
  const headers = cleanHeadersBasic(init?.headers);

  console.log("[obsidian-chat] streamingFetch:", url);

  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: Object.keys(headers).length ? headers : undefined,
    body: init?.body as BodyInit | undefined,
    signal: init?.signal,
  });

  if (!response.ok) {
    // Read the error body for logging.
    const text = await response.text();
    console.warn("[obsidian-chat] streamingFetch HTTP error:", {
      url,
      status: response.status,
      body: text.slice(0, 1000),
    });
    // Return a new Response with the error body so the SDK can parse it.
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    });
  }

  return response;
}
