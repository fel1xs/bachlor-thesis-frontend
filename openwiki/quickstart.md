# WiFa Assist Chat UI — Quickstart

WiFa Assist is a streaming chat frontend for the **Wirtschaftswissenschaftliche Fakultät (WiFa) der Universität Leipzig**. It provides a browser-based chat interface that proxies conversations to an n8n AI agent, with support for live tool-status display and inline email approval (`send_mail` tool).

## What This Repository Is

A lightweight, dependency-free web application built with vanilla JavaScript and Node.js:

- **Frontend** (`index.html`, `app.js`, `styles.css`) — single-page chat UI with session history, markdown rendering, tool status indicators, and mail approval cards
- **Backend** (`server.js`) — minimal Node HTTP server that serves static files and proxies two API routes to upstream n8n webhooks, keeping CORS and streaming manageable in the browser
- **No build step** — no bundler, no transpiler, no framework. Files are served as-is.

The app is designed for students and staff to ask questions about studies, organization, and faculty offerings. Responses are AI-generated and not legally binding.

## Quick Start

```bash
npm start
```

The app is then available at [http://localhost:3000](http://localhost:3000).

### Prerequisites

- Node.js (v18+ recommended for native `fetch` support in `server.js`)
- No `npm install` needed — there are zero runtime dependencies

### Environment Variables

The server reads configuration from a `.env` file in the project root. Copy `.env.example` to `.env` and adjust the values:

```bash
copy .env.example .env
npm start
```

All three webhook URLs are **required** — the server exits on startup if any are missing.

| Variable | Purpose |
|---|---|
| `PORT` | Server listen port (default `3000`) |
| `N8N_WEBHOOK_URL` | Upstream n8n chat webhook |
| `N8N_STATUS_WEBHOOK_URL` | Upstream n8n status webhook |
| `N8N_MAIL_CONFIRM_WEBHOOK_URL` | Upstream n8n mail confirmation webhook |

## Project Structure

```
index.html      App markup: sidebar, chat area, composer
app.js          Client logic: streaming, sessions, history, markdown, status, mail approval
server.js       Node HTTP server: static files + /api/chat + /api/chat-status + /api/confirm-mail proxy
styles.css      Full UI styling
favicon.svg     Favicon
package.json    Project metadata, single "start" script
```

## Where to Go Next

- [Architecture](architecture.md) — server design, client design, request lifecycle, session/history model
- [n8n Integration](n8n-integration.md) — webhook endpoints, streaming protocol, status polling, mail approval workflow, environment configuration

## Key Concepts

- **Session ID** (`sessionId`) — a UUID persisted in `localStorage` that identifies a conversation. Used for history storage and sent to n8n for conversation continuity.
- **Run ID** (`run_id`) — a per-message UUID identifying a single agent run. Used to correlate tool-status events and mail approval decisions with a specific request.
- **Tool Status Polling** — after sending a message, the client polls `/api/chat-status` every 700ms to display real-time tool execution progress.
- **Mail Approval Cards** — when the n8n agent invokes `send_mail`, the UI renders an inline approval card with confirm/decline buttons instead of a plain status bubble. The user's decision is sent to the local proxy at `/api/confirm-mail`, which forwards it to the n8n `confirm_mail` webhook.
