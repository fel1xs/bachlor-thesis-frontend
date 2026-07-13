const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and set the values.");
    process.exit(1);
  }

  return value;
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = requireEnv("N8N_WEBHOOK_URL");
const STATUS_WEBHOOK_URL = requireEnv("N8N_STATUS_WEBHOOK_URL");
const MAIL_CONFIRM_WEBHOOK_URL = requireEnv("N8N_MAIL_CONFIRM_WEBHOOK_URL");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function looksLikeEmptyStatusResult(text) {
  if (!text) {
    return false;
  }

  return text.includes("No item to return was found");
}

function serveStaticFile(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

async function parseJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function handleChat(req, res) {
  try {
    const body = await parseJsonBody(req);
    const upstreamUrl = new URL(WEBHOOK_URL);
    upstreamUrl.searchParams.set("action", "sendMessage");

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json, text/plain",
      },
      body: JSON.stringify({
        chatInput: body.message,
        sessionId: body.sessionId,
        run_id: body.runId,
        metadata: body.metadata || {},
      }),
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const message = await upstreamResponse.text();
      sendJson(res, upstreamResponse.status, {
        error: "Upstream webhook error",
        details: message || upstreamResponse.statusText,
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    sendJson(res, 500, {
      error: "Chat request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleMailConfirm(req, res) {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = parsedUrl.searchParams.get("sessionId");
    const action = parsedUrl.searchParams.get("action");
    const message = parsedUrl.searchParams.get("message");
    const runId =
      parsedUrl.searchParams.get("runId") ||
      parsedUrl.searchParams.get("run_id");

    if (!sessionId || !action || !message) {
      sendJson(res, 400, { error: "Missing sessionId, action, or message" });
      return;
    }

    const upstreamUrl = new URL(MAIL_CONFIRM_WEBHOOK_URL);
    upstreamUrl.searchParams.set("sessionId", sessionId);
    upstreamUrl.searchParams.set("action", action);
    upstreamUrl.searchParams.set("message", message);

    if (runId) {
      upstreamUrl.searchParams.set("runId", runId);
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json, text/plain",
      },
    });

    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      sendJson(res, upstreamResponse.status, {
        error: "Upstream mail confirmation webhook error",
        details: text || upstreamResponse.statusText,
      });
      return;
    }

    try {
      const payload = text ? JSON.parse(text) : null;
      sendJson(res, 200, payload);
    } catch {
      sendJson(res, 200, { message: text });
    }
  } catch (error) {
    sendJson(res, 500, {
      error: "Mail confirmation request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleChatStatus(req, res) {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = parsedUrl.searchParams.get("sessionId");
    const runId =
      parsedUrl.searchParams.get("runId") ||
      parsedUrl.searchParams.get("run_id");

    if (!sessionId && !runId) {
      sendJson(res, 400, { error: "Missing sessionId or runId" });
      return;
    }

    const upstreamUrl = new URL(STATUS_WEBHOOK_URL);
    if (sessionId) {
      upstreamUrl.searchParams.set("sessionId", sessionId);
    }
    if (runId) {
      upstreamUrl.searchParams.set("run_id", runId);
      upstreamUrl.searchParams.set("runId", runId);
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json, text/plain",
      },
    });

    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok && looksLikeEmptyStatusResult(text)) {
      sendJson(res, 200, []);
      return;
    }

    if (!upstreamResponse.ok) {
      sendJson(res, upstreamResponse.status, {
        error: "Upstream status webhook error",
        details: text || upstreamResponse.statusText,
      });
      return;
    }

    try {
      const payload = text ? JSON.parse(text) : null;
      sendJson(res, 200, payload);
    } catch {
      sendJson(res, 200, { message: text });
    }
  } catch (error) {
    sendJson(res, 500, {
      error: "Status request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/chat-status")) {
    handleChatStatus(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/confirm-mail")) {
    handleMailConfirm(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStaticFile(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Chat UI running on http://localhost:${PORT}`);
});
