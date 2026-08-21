# Obsidian Chat

Cloud AI chat inside Obsidian — a replacement for your mobile AI chat app. Attach
vault files and folders as context, chat with cloud models, and every chat is
saved as a single markdown file. Works on desktop and mobile.

## Features

- **Cloud providers** via official third-party SDKs: OpenAI (and OpenAI-compatible
  endpoints) + Anthropic.
- **Context from your vault**: attach files or whole folders (expanded into
  individual files at attach time). Images (png/jpg/gif/webp/bmp) are sent as
  multimodal content; PDFs are text-extracted automatically.
- **Separate image model**: use a cheaper text model for normal chat and a
  vision model (e.g. `gpt-4o`) only when images are attached.
- **Streaming-style output**: simulated typewriter effect with blinking cursor
  (works everywhere — `requestUrl` bypasses CORS, so no network-level streaming).
- **Thinking display**: models that expose reasoning (DeepSeek, Anthropic
  thinking) show it in a collapsible `💭 Thinking` section, persisted to the
  chat file.
- **Context manager tab**: a dedicated view listing all attached files (name,
  path, size) with add/remove/clear. Auto-opens a chat if none is active.
- **Every chat is one markdown file**: YAML frontmatter (title, provider, model,
  context, usage) + readable `## 👤 User` / `## 🤖 Assistant` turns. Review past
  chats for free — nothing bleeds into a new chat unless you explicitly attach it.
- **Token transparency**: live token counters + a token estimate for attached
  context before you send.
- **Editable chat title**: rename the chat file inline from the chat view.
- **Mobile-friendly**: compact layout, safe-area aware, works with the mobile
  keyboard.

## Providers

- **OpenAI** — `openai` SDK, `api.openai.com` or any OpenAI-compatible base URL.
- **Anthropic** — `@anthropic-ai/sdk`.

All network calls go through Obsidian's `requestUrl` (wrapped as `fetch` for the
SDKs), which works on mobile and bypasses CORS.

## Install (dev)

```bash
npm install
npm run build
```

Copy/symlink `manifest.json`, `main.js`, `styles.css` into
`<vault>/.obsidian/plugins/obsidian-chat/`, then enable the plugin and set your API
key in Settings → Obsidian Chat.

## Usage

- **New AI chat** — ribbon icon or command. Isolated chat, no history bleed.
- **Resume AI chat** — pick an existing chat file and continue it.
- **Context bar** (📎 in the chat view) — opens the context manager tab.
  Add files or folders; see the token estimate.
- **Attach file / folder** — commands or the context tab.
- **Send** — Cmd/Ctrl+Enter or the Send button. Stop cancels mid-response.
- Each turn is appended to the chat's markdown file; usage is tracked in
  frontmatter.

## Reviewing previous chats (no token surprise)

Every chat is a normal markdown note under `AI Chats/` (configurable). Browsing
and reading them is free. Nothing from past chats enters a new chat unless you
explicitly attach it, and the token cost is always shown first.

## Notes & limitations

- Responses are non-streaming at the network level (`requestUrl` buffers the
  full body); the typewriter effect is simulated client-side.
- Streaming via native `fetch` is blocked by CORS in Obsidian's webview, so it is
  not used.
- Images are re-sent each turn while attached (stateless API). Remove the image
  from context after asking to stop re-paying for it.
- PDFs are text-extracted via `unpdf`; scanned/image-only PDFs yield no text.
