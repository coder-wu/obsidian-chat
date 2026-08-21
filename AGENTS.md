# AGENTS.md — Obsidian Chat plugin

Guidance for AI agents (and humans) working on this codebase.

## Project overview

Obsidian plugin providing cloud-AI chat inside Obsidian (desktop + mobile).
TypeScript, bundled with esbuild to `main.js`. Every chat is saved as a markdown
file in the vault. Vault files/folders can be attached as AI context.

## Commands

```bash
npm install        # install deps
npm run dev        # build main.js (unminified, inline sourcemap)
npm run build      # build main.js (production, minified)
npx tsc --noEmit   # type-check (esbuild does NOT type-check!)
```

Always run `npx tsc --noEmit` before building — esbuild will happily emit code
with type errors.

Install into a vault by copying/symlinking `manifest.json`, `main.js`,
`styles.css` to `<vault>/.obsidian/plugins/obsidian-chat/`.

## Architecture

```
src/
  main.ts              plugin entry: settings load, view registration, commands
  settings.ts          settings model + settings tab UI
  types.ts             ChatMessage (string | ContentPart[]), AIProvider, etc.
  providers/
    fetchAdapter.ts    obsidianFetch (requestUrl as fetch) + streamingFetch (native fetch)
    openai.ts          OpenAI + OpenAI-compatible provider (chat + chatStream)
    anthropic.ts       Anthropic provider (chat + chatStream)
    index.ts           getProvider() factory
  chat/
    format.ts          parse/serialize chat markdown files (frontmatter + messages)
    tokenEstimate.ts   chars/4 token estimator
  context/
    builder.ts         build text/image context from attached files
    picker.ts          FuzzySuggestModals for files/folders/chats
  ui/
    ChatView.ts        the chat view (ItemView)
    ContextView.ts     context manager tab (ItemView)
```

Two registered view types:
- `obsidian-chat` → `ChatView`
- `obsidian-chat-context` → `ContextView`

Views share state via the **active** ChatView: `plugin.getActiveChatView()`
returns the active ChatView; ContextView reads/writes its `context` field.

## Hard-won knowledge (read before touching these areas)

### 1. `useDefineForClassFields` MUST stay `false` (tsconfig.json)

With `target: ES2022` TS defaults `useDefineForClassFields: true`, which emits
`Object.defineProperty(this, field, {value: undefined})` for declared fields.
This **overwrites Obsidian core's internal View properties** (core `View` has its
own `titleEl`, `contentEl`, etc.). Symptom: core `View.load()` crashes with
`Cannot read properties of undefined (reading 'setText')` before `onOpen` runs.

- tsconfig has `"useDefineForClassFields": false`.
- Do not re-enable it. Also avoid naming plugin fields the same as core View
  internals (`titleEl` etc.) — the view uses `aiTitleEl` for this reason.

### 2. View lifecycle: `setState` can run before `onOpen`

Obsidian may call `view.setState(state, result)` before `onOpen()` builds the
DOM. `ChatView` defers state via `pendingState`/`domReady`: `setState` stashes,
`onOpen` builds DOM then applies. Always guard `newChat`/`loadFromFile` with
`if (!this.domReady) return;` and never call view methods directly right after
`setViewState()` from the plugin — drive the view through `setViewState` state
instead.

### 3. Network: `requestUrl` vs native `fetch`

- `requestUrl` (Obsidian API): works on mobile, bypasses CORS, but **no
  streaming** (buffers full body).
- Native `fetch`: supports `ReadableStream` but is **blocked by CORS** in
  Obsidian's webview (`app://obsidian.md` origin).

Consequences:
- All requests go through `requestUrl` (via `obsidianFetch`).
- "Streaming" is **simulated client-side**: fetch full response, reveal text
  gradually (see `ChatView.simulateStream`). Do not try to switch back to native
  `fetch` streaming — it will fail with CORS on most providers.
- Native `fetch` restricted headers (`content-length` etc.) must be stripped for
  `requestUrl` or Electron throws `ERR_INVALID_ARGUMENT`.
- AbortSignal does NOT cancel `requestUrl` requests — check `signal.aborted`
  after the await and discard the result.

### 4. Mobile top offset (view-header margin)

Obsidian mobile adds `margin-top` to `.view-content` = safe-area + view-header
height (~99px on iPhone). The plugin hides the view-header (redundant with its
own toolbar) and re-applies that offset as `padding-top` on the view root.

Logic in `ChatView.adjustMobileMargin()` / `ContextView.adjustMobileMargin()`:
- Reads `getComputedStyle(viewContent).marginTop` **with retries** (Obsidian
  applies it asynchronously; a single read often returns 0).
- If > 0: zero the margin (`!important`) and set `padding-top` on the root.

Always keep this adaptive (read actual values) — hardcoded px values break on
different devices.

### 5. Context files & folders

- Attaching a folder expands it into individual file paths **at attach time**
  (`ChatView.addFolder` uses `app.vault.getFiles()` filtered by path prefix —
  do NOT walk `folder.children`, it can be empty due to lazy loading on mobile).
- `buildContext` only processes `context.files`; images → `ImagePart` (base64),
  PDFs → extracted text via `unpdf`, text files → `TextPart`.
- Context is rebuilt on every send (files re-read from disk).
- Size limits: `maxFileBytes` (text) and `maxImageBytes` (images), configurable.

### 6. Multimodal messages

`ChatMessage.content` is `string | ContentPart[]`. Serialization to the chat
markdown file keeps only text parts (images are NOT persisted). When building a
request, image parts are attached to the **last user message** (images can't go
in system messages). Providers convert parts to their own format
(`image_url` for OpenAI, `image`/`document` blocks for Anthropic).

### 7. Versioning

Bump `manifest.json`, `package.json`, and `versions.json` together on each
release (user increments by 0.0.1 per release).

## Gotchas

- `unpdf` (PDF text extraction) is bundled — main.js is ~1.7MB.
- `listModels()`: Anthropic SDK 0.30.x has no models endpoint → static list.
- Chat markdown format: `## 👤 User` / `## 🤖 Assistant` headings; thinking
  stored between `<!--thinking-->` / `<!--end-thinking-->` HTML comments.
- `serializeMessages` strips thinking markers on write and re-parses them on read.
