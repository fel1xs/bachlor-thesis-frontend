# Architecture

## Overview

WiFa Assist is a two-tier application with no build step and zero runtime dependencies:

```
Browser (index.html + app.js + styles.css)
    │
    │  POST /api/chat          GET /api/chat-status
    │  (streaming)             (polling)
    ▼
server.js (Node HTTP server)
    │
    │  POST webhook/chat       GET webhook/chat-status
    │  (SSE / text stream)     (JSON)
    ▼
n8n Agent (upstream webhooks)
```

The server is a thin proxy. All chat logic — session management, streaming, markdown rendering, status display, mail approval — lives in the browser client.

---

## Server (`server.js`)

A single-file Node.js HTTP server using only built-in modules (`http`, `fs`, `path`, `url`) and the global `fetch` API (Node 18+).

### Routes

| Method | Path | Handler | Purpose |
|---|---|---|---|
| POST | `/api/chat` | `handleChat` | Proxies chat message to upstream n8n webhook, streams response back |
| GET | `/api/chat-status` | `handleChatStatus` | Proxies status query to upstream n8n status webhook |
| GET | `/api/confirm-mail` | `handleMailConfirm` | Proxies mail approval decision to upstream n8n confirm_mail webhook |
| GET | `*` | `serveStaticFile` | Serves static files from the project root (index.html, app.js, styles.css, etc.) |
| * | `*` | — | Returns 405 Method Not Allowed |

### `/api/chat` Proxy Details

- Reads JSON body: `{ message, sessionId, runId, metadata }`
- Forwards to `WEBHOOK_URL` with query param `?action=sendMessage`
- Sends upstream body as `{ chatInput, sessionId, run_id, metadata }`
- Streams the upstream response body directly to the client (`text/plain`, `Connection: keep-alive`, `X-Accel-Buffering: no`)
- This pass-through design means the server does not parse or transform the stream — it just pipes bytes

### `/api/chat-status` Proxy Details

- Accepts `sessionId` and/or `runId` query parameters
- Forwards to `STATUS_WEBHOOK_URL` with both `run_id` and `runId` params (covers n8n naming variations)
- Handles n8n's "No item to return was found" response by returning an empty array `[]`
- Tries JSON parse first, falls back to `{ message: text }` if the response isn't valid JSON

### `/api/confirm-mail` Proxy Details

- Accepts `sessionId`, `action`, `message`, and optional `runId` (or `run_id`) query parameters
- Validates that `sessionId`, `action`, and `message` are present (returns 400 otherwise)
- Forwards to `MAIL_CONFIRM_WEBHOOK_URL` with `sessionId`, `action`, `message`, and `runId` query params
- Tries JSON parse first, falls back to `{ message: text }` if the response isn't valid JSON

### Static File Serving

- Path traversal protection: normalizes the path and verifies the resolved file is within `__dirname`
- MIME types are mapped for `.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.jpg`, `.ico`
- All responses use `Cache-Control: no-store`

### Configuration

- `PORT` — listen port (default `3000`)
- `N8N_WEBHOOK_URL` — upstream chat webhook (required)
- `N8N_STATUS_WEBHOOK_URL` — upstream status webhook (required)
- `N8N_MAIL_CONFIRM_WEBHOOK_URL` — upstream mail confirmation webhook (required)
- `.env` file — loaded automatically by `loadEnvFile()` on startup; variables are only set if not already in `process.env`
- `requireEnv()` — exits the process with an error if any of the three webhook URLs are missing

---

## Client (`app.js`)

A vanilla ES module loaded via `<script type="module">` in `index.html`. All state is in-memory or in `localStorage`.

### Session & History Model

Three `localStorage` keys:

| Key | Shape | Purpose |
|---|---|---|
| `wifa-chat-session` | `string` (UUID) | Current session ID |
| `wifa-chat-history` | `{ [sessionId]: HistoryEntry[] }` | Full conversation per session |
| `wifa-chat-history-meta` | `{ [sessionId]: { updatedAt, label } }` | Metadata for sidebar display |

**HistoryEntry** is either:
- `{ role: "user" | "assistant", content: string }` — standard message
- `{ type: "mail-card", message: string, runId: string, decision: "pending" | "confirm" | "decline" }` — mail approval card

**Session lifecycle:**
- On first load, a UUID is generated and stored
- "Neue Unterhaltung" (new conversation) button generates a fresh UUID, clears the message area, and re-renders
- Up to 3 most recent sessions (by `updatedAt`) appear in the sidebar history list
- Clicking a history item switches sessions, aborting any active request

### Message Rendering

- User messages: rendered as plain text (`textContent`)
- Assistant messages: rendered through a custom markdown renderer
- Markdown supports: fenced code blocks (` ``` `), inline code, links, bold (`**` / `__`), italic (`*`), blockquotes, unordered lists, ordered lists
- `<thought>` blocks are stripped from assistant output before rendering
- HTML is escaped before markdown transformation to prevent injection

### Streaming Protocol

The client expects the n8n upstream to send a stream of JSON objects (not SSE `data:` lines). The parser works as follows:

1. Accumulate incoming chunks into a buffer
2. `collectJsonObjects()` scans for balanced `{` / `}` pairs, respecting string boundaries and escape characters
3. Each extracted JSON object is parsed; objects with `type: "item"` yield `content` which is passed to `extractDisplayText()`
4. `extractDisplayText()` tries fields in order: `output`, `text`, `content`, `message`, `delta`
5. If `content` itself looks like JSON, it's parsed recursively
6. If no structured objects are found, raw text accumulates as a fallback
7. When the stream ends and no structured content was parsed, the raw buffer is used as the final answer

### Status Polling

After sending a message, the client starts polling `/api/chat-status` every **700ms**:

1. Polls with current `sessionId` and `activeRunId`
2. Filters responses to entries matching the `runId` and timestamped after the question was sent
3. Only renders entries with a non-empty `tool` field (the `workflow` tool is excluded)
4. Uses a signature-based deduplication to avoid re-rendering identical status updates
5. Polling stops when the streaming response completes or the session changes

### Mail Approval Cards

When a status entry has `tool === "send_mail"` and `status === "started"` with a `message`, the UI renders an inline approval card instead of a status bubble:

- The card shows the email draft content
- "Senden bestätigen" (confirm) and "Nicht senden" (decline) buttons
- The decision is sent to the local proxy at `/api/confirm-mail` (which forwards to the n8n `confirm_mail` webhook) via GET with query params: `sessionId`, `action`, `message`, `runId`
- The card state is persisted in history, so switching sessions preserves prior decisions
- Cards are inserted before the active streaming assistant article so they appear in-context

### Mobile Navigation

- Below 980px viewport width, the sidebar becomes an off-canvas panel
- Toggle via the "Menü" button, close via "Schließen" button or backdrop click
- Quick links (AlmaWeb, Moodle, WiFa website) close the menu on navigation

---

## Request Lifecycle

```
User types message & submits
  │
  ├─ User message rendered & persisted to history
  ├─ setBusy(true) — input disabled
  │
  ├─ POST /api/chat { message, sessionId, runId, metadata }
  │    └─ server.js proxies to n8n webhook with ?action=sendMessage
  │
  ├─ Assistant bubble created (streaming state)
  ├─ Status element created
  ├─ Status polling starts (700ms interval)
  │
  ├─ Stream chunks arrive → parsed for JSON objects → delta text rendered as markdown
  │    └─ Each chunk: collectJsonObjects → parse → extractDisplayText → setBubbleContent
  │
  ├─ Stream ends → final text stripped & persisted → streaming class removed
  ├─ Status polling stops
  ├─ setBusy(false) — input re-enabled
  │
  └─ If error: error message rendered, polling stopped, busy state cleared
```

---

## What to Watch Out For

- **No dependencies**: `package.json` has no `dependencies`. The server relies on Node 18+ global `fetch`.
- **No tests**: there are no test files or test scripts in the repository.
- **Required env vars**: `N8N_WEBHOOK_URL`, `N8N_STATUS_WEBHOOK_URL`, and `N8N_MAIL_CONFIRM_WEBHOOK_URL` must all be set (via `.env` file or environment). The server exits on startup if any are missing.
- **Streaming format assumption**: The client expects JSON objects in the stream, not SSE `data:` events. If the n8n workflow changes its streaming format, the parser in `normalizeStreamChunk()` and `collectJsonObjects()` must be updated.
- **Path traversal protection**: `serveStaticFile` normalizes paths and checks `filePath.startsWith(__dirname)`. If adding new static file routes, maintain this guard.
- **Status deduplication**: Status entries are deduplicated by a composite signature (`runId|ts|tool|label|status|message`). Changing any of these fields on the n8n side may cause duplicate renders.
