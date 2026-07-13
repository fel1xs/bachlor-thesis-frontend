# WiFa Assist Chat UI

Modernes Chat-Frontend fuer den WiFa-Agenten der Universitaet Leipzig mit Streaming, Verlaufsspeicherung, Tool-Status und Mail-Freigabe.

## Starten

```bash
npm start
```

Danach ist die App unter [http://localhost:3000](http://localhost:3000) erreichbar.

## Projektstruktur

- `index.html`: Markup der App
- `styles.css`: komplettes UI-Styling
- `app.js`: Chat-Logik, Streaming, Verlauf, Tool-Status, Mail-Freigabe
- `server.js`: kleiner lokaler Proxy fuer Chat und Status

## Funktionen

- Streaming-Chat gegen den n8n-Agenten
- lokale Session- und Verlaufsspeicherung im Browser
- Tool-Status im Chat, inklusive spezieller Mail-Freigabe fuer `send_mail`
- Markdown-Rendering fuer Assistant-Antworten
- mobile Off-Canvas-Navigation fuer Verlauf und Schnelllinks

## Erwartete n8n-Schnittstellen

Die App proxied drei n8n-Webhooks ueber den lokalen Server. Die Upstream-URLs werden per `.env` konfiguriert (siehe `.env.example`).

Der Chat wird mit `chatInput`, `sessionId` und `run_id` angesprochen. Die UI verwendet:

- `sessionId` fuer Unterhaltung, Verlauf und lokale Wiederaufnahme
- `run_id` fuer einzelne Agent-Laeufe, Tool-Events und Mail-Freigaben

## Lokaler Proxy

Der lokale Node-Server stellt diese Routen bereit:

- `POST /api/chat`
- `GET /api/chat-status`
- `GET /api/confirm-mail`

Damit bleiben CORS und Streaming im Browser einfach beherrschbar.

## Konfiguration

Kopiere `.env.example` nach `.env` und passe die Werte an:

```bash
copy .env.example .env
npm start
```

| Variable | Zweck |
|---|---|
| `PORT` | Server-Port (Standard: `3000`) |
| `N8N_WEBHOOK_URL` | n8n-Chat-Webhook |
| `N8N_STATUS_WEBHOOK_URL` | n8n-Status-Webhook |
| `N8N_MAIL_CONFIRM_WEBHOOK_URL` | n8n-Mail-Bestaetigungs-Webhook |
