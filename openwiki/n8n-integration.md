# n8n Integration

The WiFa Assist UI is a frontend for an n8n-based AI agent. This page documents the three upstream webhook endpoints, the streaming protocol, status polling, and the mail approval workflow.

## Webhook Endpoints

### 1. Chat Webhook

| | |
|---|---|
| **Upstream URL** | `https://n8n-1.salzer-siegel.de/webhook/32c1e9c8-dc4f-48e2-90a0-bac3f53e3e09/chat` |
| **Configurable via** | `N8N_WEBHOOK_URL` env var |
| **Proxy route** | `POST /api/chat` |
| **Query params added** | `?action=sendMessage` |

**Request body** (sent by `server.js` `handleChat`):

```json
{
  "chatInput": "user message text",
  "sessionId": "uuid",
  "run_id": "uuid",
  "metadata": { "source": "wifa-chat-ui" }
}
```

**Response**: A streamed text response. The server passes it through as `text/plain` with `Connection: keep-alive` and `X-Accel-Buffering: no` to prevent proxy buffering.

### 2. Status Webhook

| | |
|---|---|
| **Upstream URL** | `https://n8n-1.salzer-siegel.de/webhook/chat-status` |
| **Configurable via** | `N8N_STATUS_WEBHOOK_URL` env var |
| **Proxy route** | `GET /api/chat-status` |

**Query parameters** forwarded to upstream:

| Param | Source | Purpose |
|---|---|---|
| `sessionId` | client session UUID | Conversation-level status lookup |
| `run_id` | client-generated run UUID | Run-level status lookup |
| `runId` | same as `run_id` | Duplicate param for n8n compatibility |

**Response**: JSON array of status entries. The server handles n8n's "No item to return was found" empty result by returning `[]` (HTTP 200).

### 3. Mail Confirmation Webhook

| | |
|---|---|
| **Upstream URL** | Configured via `N8N_MAIL_CONFIRM_WEBHOOK_URL` env var |
| **Configurable via** | `.env` file (required) |
| **Proxy route** | `GET /api/confirm-mail` |

**Query parameters** forwarded to upstream:

| Param | Source | Purpose |
|---|---|---|
| `sessionId` | client session UUID | Conversation context |
| `action` | `"confirm"` or `"decline"` | User's approval decision |
| `message` | email draft text | The email content being approved/rejected |
| `runId` | client-generated run UUID (optional) | Associates with specific agent run |

The proxy validates that `sessionId`, `action`, and `message` are present (returns 400 otherwise), then forwards the request upstream and returns the JSON response (or `{ message: text }` if the upstream response isn't valid JSON).

---

## Streaming Protocol

The n8n chat webhook returns a stream of JSON objects (not SSE `data:` lines). The client-side parser in `app.js` handles this in three stages:

### Stage 1: Buffer accumulation (`normalizeStreamChunk`)

Incoming byte chunks are decoded to text and appended to a state buffer.

### Stage 2: JSON object extraction (`collectJsonObjects`)

Scans the buffer for balanced `{` / `}` pairs while respecting:
- String boundaries (quotes)
- Escape characters (`\`)
- Nested objects (depth tracking)

Returns `{ objects: string[], remainder: string }` where `remainder` is any incomplete JSON at the buffer's end.

### Stage 3: Content extraction (`extractDisplayText`)

Each complete JSON object is parsed. Objects with `type: "item"` have their `content` field extracted. The extraction tries these fields in order:

1. `payload.output`
2. `payload.text`
3. `payload.content`
4. `payload.message`
5. `payload.delta`

If the `content` value itself looks like JSON (starts with `[`, `{`, or `"`), it's parsed recursively and extraction is attempted again.

### Fallback behavior

- If no structured `type: "item"` objects are found, raw text accumulates as a fallback
- `<thought>` blocks are stripped from all assistant output before rendering
- If the final extracted text is empty, the raw buffer is used as the answer
- If still empty, the UI shows: "Keine Antwort erhalten. Bitte prüfe den n8n-Workflow."

---

## Status Polling

When a user sends a message, the client begins polling `/api/chat-status` at **700ms intervals** (see `startStatusPolling` in `app.js`).

### Entry filtering

Each polled response is an array of status entries. An entry is renderable if:

1. It's an object with a non-empty `tool` field
2. The `tool` is not `"workflow"` (filtered out)
3. The entry's `runId` / `run_id` matches the active run (if both are present)
4. The entry's `ts` timestamp is at or after the question's send time (if both are present)

### Deduplication

Entries are deduplicated by a composite signature:

```
runId|ts|tool|label|status|message
```

Only entries with a new signature are rendered, preventing duplicate UI updates on identical poll responses.

### Display format

| `status` value | Label shown |
|---|---|
| `started` | "Tool gestartet" |
| `finished` | "Tool abgeschlossen" |
| `failed` | "Tool fehlgeschlagen" |
| *(other)* | "Agent-Status" |

Text content comes from `entry.label`, falling back to `entry.message`, then `entry.tool`.

### Polling lifecycle

- Started immediately after the chat request is sent
- Polls every 700ms via `setInterval`
- Stopped when:
  - The streaming response completes
  - The user switches sessions
  - The user starts a new conversation
  - An error occurs during streaming

---

## Mail Approval Workflow

This is the most complex interactive feature. When the n8n agent invokes the `send_mail` tool, the UI presents an approval card instead of a standard status message.

### Flow

```
n8n agent invokes send_mail tool
  │
  ├─ Status poll returns entry with:
  │    tool: "send_mail", status: "started", message: "<email draft>"
  │
  ├─ applyStatusUpdate() detects send_mail
  │    └─ Hides the status bubble
  │    └─ Calls ensureMailCard(entry)
  │         └─ Checks history for duplicate card (by message + runId)
  │         └─ Creates inline approval card before the streaming assistant article
  │
  ├─ User clicks "Senden bestätigen" or "Nicht senden"
  │    └─ Both buttons disabled
  │    └─ GET /api/confirm-mail
  │         ?sessionId=...&action=confirm|decline&message=...&runId=...
  │         └─ server.js proxies to N8N_MAIL_CONFIRM_WEBHOOK_URL
  │    └─ On success: card updated with decision, persisted to history
  │    └─ On error: buttons re-enabled, error message shown
  │
  └─ Card state persisted in localStorage history
       └─ Decision: "pending" → "confirm" | "decline"
       └<arg_value> Survives session switching and page reloads
```

### Card data structure (in history)

```json
{
  "type": "mail-card",
  "message": "email draft content...",
  "runId": "uuid",
  "decision": "pending" | "confirm" | "decline"
}
```

### Important behaviors

- **Proxied through server**: The mail confirmation is sent to the local proxy at `/api/confirm-mail`, which forwards it to the upstream n8n webhook. This keeps all n8n communication server-side and avoids CORS issues in the browser.
- **Idempotency**: `ensureMailCard` checks history for an existing card with the same `message` and `runId` before creating a new one.
- **Persistence**: Mail card decisions are stored in session history and restored when switching back to the session via `renderStoredHistory()`.
- **Insertion position**: Cards are inserted before `activeStreamingAssistantArticle` so they appear in the conversation flow at the right point, before the assistant's response completes.

---

## Configuration Summary

| Variable | Required | Where used |
|---|---|---|
| `PORT` | No (default `3000`) | `server.js` — listen port |
| `N8N_WEBHOOK_URL` | Yes | `server.js` — chat proxy upstream |
| `N8N_STATUS_WEBHOOK_URL` | Yes | `server.js` — status proxy upstream |
| `N8N_MAIL_CONFIRM_WEBHOOK_URL` | Yes | `server.js` — mail confirmation proxy upstream |

> All three webhook URLs are required. The server loads a `.env` file on startup and calls `requireEnv()` for each — if any is missing, the server prints an error and exits. See `.env.example` for the expected format.
