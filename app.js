const STORAGE_KEY = "wifa-chat-session";
const HISTORY_KEY = "wifa-chat-history";
const HISTORY_META_KEY = "wifa-chat-history-meta";
const DEFAULT_ASSISTANT_MESSAGE =
  "Hallo! Ich unterstütze dich bei Fragen zur Wirtschaftswissenschaftlichen Fakultät der Universität Leipzig. Was möchtest du wissen?";

const chatForm = document.querySelector("#chatForm");
const messageInput = document.querySelector("#messageInput");
const messages = document.querySelector("#messages");
const sendButton = document.querySelector("#sendButton");
const resetButton = document.querySelector("#resetButton");
const sessionNote = document.querySelector("#sessionNote");
const historyList = document.querySelector("#historyList");
const sidebar = document.querySelector("#sidebar");
const mobileMenuButton = document.querySelector("#mobileMenuButton");
const mobileCloseButton = document.querySelector("#mobileCloseButton");
const mobileNavBackdrop = document.querySelector("#mobileNavBackdrop");

let sessionId = getStoredSessionId();
let activeRequest = null;
let activeStatusPoller = null;
let activeQuestionTimestamp = null;
let activeStreamingAssistantArticle = null;
let activeRunId = null;

function isMobileViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function syncMobileMenuUi(isOpen) {
  document.body.classList.toggle("mobile-menu-open", isOpen);

  if (mobileMenuButton) {
    mobileMenuButton.setAttribute("aria-expanded", String(isOpen));
  }

  if (mobileNavBackdrop) {
    mobileNavBackdrop.hidden = !isOpen;
  }
}

function openMobileMenu() {
  if (!isMobileViewport()) {
    return;
  }

  syncMobileMenuUi(true);
}

function closeMobileMenu() {
  syncMobileMenuUi(false);
}

function getStoredSessionId() {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const created = crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}

function createRunId() {
  return crypto.randomUUID();
}

function resetSession() {
  sessionId = crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, sessionId);
  renderSessionNote();
  renderStoredHistory();
  renderConversationList();
  closeMobileMenu();
}

function renderSessionNote() {
  sessionNote.textContent = `Session-ID: ${sessionId}`;
}

function getHistoryStore() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setHistoryStore(store) {
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
}

function getHistoryMetaStore() {
  try {
    const raw = window.localStorage.getItem(HISTORY_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setHistoryMetaStore(store) {
  window.localStorage.setItem(HISTORY_META_KEY, JSON.stringify(store));
}

function getSessionHistory() {
  const store = getHistoryStore();
  return Array.isArray(store[sessionId]) ? store[sessionId] : [];
}

function saveSessionHistory(history) {
  const store = getHistoryStore();
  store[sessionId] = history;
  setHistoryStore(store);
}

function summarizeHistoryLabel(history) {
  const firstUserEntry = history.find((entry) => entry.role === "user" && entry.content.trim());
  if (!firstUserEntry) {
    return "Neue Unterhaltung";
  }

  return firstUserEntry.content.replace(/\s+/g, " ").trim().slice(0, 88);
}

function upsertHistoryMeta() {
  const history = getSessionHistory();
  const metaStore = getHistoryMetaStore();
  metaStore[sessionId] = {
    updatedAt: Date.now(),
    label: summarizeHistoryLabel(history),
  };
  setHistoryMetaStore(metaStore);
}

function appendHistoryEntry(role, content) {
  const history = getSessionHistory();
  history.push({ role, content });
  saveSessionHistory(history);
  upsertHistoryMeta();
  renderConversationList();
}

function appendMailCardEntry(message, runId = "") {
  const history = getSessionHistory();
  history.push({
    type: "mail-card",
    message,
    runId,
    decision: "pending",
  });
  saveSessionHistory(history);
  upsertHistoryMeta();
}

function updateMailCardEntry(message, runId, decision) {
  const history = getSessionHistory();
  const entry = history.find(
    (item) =>
      item &&
      item.type === "mail-card" &&
      item.message === message &&
      (runId ? item.runId === runId : true)
  );

  if (!entry) {
    return;
  }

  entry.decision = decision;
  saveSessionHistory(history);
  upsertHistoryMeta();
}

function setBusy(isBusy, status) {
  sendButton.disabled = isBusy;
  messageInput.disabled = isBusy;
  resetButton.disabled = isBusy;
}

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 220)}px`;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function stripThoughtBlocks(text) {
  return text.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, "");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(text) {
  const placeholders = [];
  const keep = (html) => {
    const token = `@@INLINE${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let result = text;

  result = result.replace(
    /`([^`]+?)`/g,
    (_, code) => keep(`<code>${code}</code>`)
  );

  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) =>
      keep(`<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`)
  );

  result = result.replace(
    /(^|[\s(])((https?:\/\/[^\s<]+))/g,
    (_, prefix, url) =>
      `${prefix}${keep(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`)}`
  );

  result = result.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__([^\n_]+?)__/g, "<strong>$1</strong>");

  result = result.replace(
    /(^|[^\w*])\*([^\s*][^*\n]*?[^\s*])\*(?=$|[^\w*])/g,
    "$1<em>$2</em>"
  );

  return result.replace(/@@INLINE(\d+)@@/g, (_, index) => placeholders[Number(index)] || "");
}

function renderMarkdown(text) {
  const sanitized = stripThoughtBlocks(text);

  if (!sanitized.trim()) {
    return "";
  }

  const escaped = escapeHtml(sanitized).replace(/\r\n/g, "\n");
  const fencePattern = /```([\s\S]*?)```/g;
  const fences = [];
  const withoutFences = escaped.replace(fencePattern, (_, code) => {
    const token = `@@CODEBLOCK${fences.length}@@`;
    fences.push(`<pre><code>${code.trim()}</code></pre>`);
    return token;
  });

  const isUnorderedListBlock = (block) => {
    const lines = block.split("\n").filter(Boolean);
    return lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line));
  };

  const isOrderedListBlock = (block) => {
    const lines = block.split("\n").filter(Boolean);
    return lines.length > 1 && lines.every((line) => /^\d+\.\s+/.test(line));
  };

  const blocks = withoutFences.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const html = blocks.map((block) => {
    if (/^@@CODEBLOCK\d+@@$/.test(block)) {
      return block;
    }

    if (block.startsWith(">")) {
      const content = block
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("<br />");
      return `<blockquote>${renderInlineMarkdown(content)}</blockquote>`;
    }

    if (isUnorderedListBlock(block)) {
      const items = block
        .split("\n")
        .map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }

    if (isOrderedListBlock(block)) {
      const items = block
        .split("\n")
        .map((line) => {
          const match = line.match(/^(\d+\.)\s+(.*)$/);
          if (!match) {
            return "";
          }

          return `<li><span class="list-marker">${match[1]}</span> ${renderInlineMarkdown(match[2])}</li>`;
        })
        .join("");
      return `<ol>${items}</ol>`;
    }

    return `<p>${renderInlineMarkdown(block).replace(/\n/g, "<br />")}</p>`;
  }).join("");

  return html.replace(/@@CODEBLOCK(\d+)@@/g, (_, index) => fences[Number(index)] || "");
}

function setBubbleContent(bubble, role, content) {
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(content);
    return;
  }

  bubble.textContent = content;
}

function createMessageElement(role, content = "", streaming = false, persist = true) {
  const normalizedContent = role === "assistant" ? stripThoughtBlocks(content) : content;
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? "AI" : "DU";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (streaming) {
    bubble.classList.add("streaming");
  }
  setBubbleContent(bubble, role, normalizedContent);

  article.append(avatar, bubble);
  messages.append(article);
  scrollToBottom();

  if (persist && normalizedContent.trim()) {
    appendHistoryEntry(role, normalizedContent);
  }

  bubble._article = article;
  return bubble;
}

async function submitMailDecision(entry, action, statusNode, confirmButton, declineButton) {
  confirmButton.disabled = true;
  declineButton.disabled = true;
  statusNode.hidden = false;
  statusNode.dataset.state = "pending";
  statusNode.textContent =
    action === "confirm"
      ? "E-Mail wird freigegeben ..."
      : "E-Mail wird abgelehnt ...";

  try {
    const params = new URLSearchParams({
      sessionId,
      action,
      message: entry.message,
    });

    if (entry.runId) {
      params.set("runId", entry.runId);
    }

    const url = `/api/confirm-mail?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain",
      },
    });

    if (!response.ok) {
      throw new Error("Bestätigung konnte nicht übermittelt werden.");
    }

    updateMailCardEntry(entry.message, entry.runId, action);
    statusNode.dataset.state = action === "confirm" ? "confirmed" : "declined";
    statusNode.textContent =
      action === "confirm"
        ? "E-Mail freigegeben und an den Workflow übermittelt."
        : "E-Mail abgelehnt und an den Workflow übermittelt.";
  } catch (error) {
    confirmButton.disabled = false;
    declineButton.disabled = false;
    statusNode.dataset.state = "error";
    statusNode.textContent =
      error instanceof Error
        ? error.message
        : "Die Entscheidung konnte nicht übermittelt werden.";
  }
}

function createMailCardElement(entry, persist = true, insertBeforeNode = null) {
  const article = document.createElement("article");
  article.className = "message assistant";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble mail-card";

  const header = document.createElement("div");
  header.className = "mail-card-header";

  const title = document.createElement("div");
  title.className = "mail-card-title";
  title.textContent = "E-Mail-Entwurf zur Freigabe";

  const badge = document.createElement("div");
  badge.className = "mail-card-badge";
  badge.textContent = "send_mail";

  header.append(title, badge);

  const body = document.createElement("div");
  body.className = "mail-card-message";
  body.textContent = entry.message;

  const actions = document.createElement("div");
  actions.className = "mail-card-actions";

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "mail-card-button confirm";
  confirmButton.textContent = "Senden bestätigen";

  const declineButton = document.createElement("button");
  declineButton.type = "button";
  declineButton.className = "mail-card-button decline";
  declineButton.textContent = "Nicht senden";

  const status = document.createElement("div");
  status.className = "mail-card-status";
  status.hidden = entry.decision === "pending";

  if (entry.decision === "confirm") {
    status.dataset.state = "confirmed";
    status.textContent = "E-Mail freigegeben und an den Workflow übermittelt.";
    confirmButton.disabled = true;
    declineButton.disabled = true;
  } else if (entry.decision === "decline") {
    status.dataset.state = "declined";
    status.textContent = "E-Mail wurde abgelehnt.";
    confirmButton.disabled = true;
    declineButton.disabled = true;
  }

  confirmButton.addEventListener("click", () => {
    submitMailDecision(entry, "confirm", status, confirmButton, declineButton);
  });

  declineButton.addEventListener("click", () => {
    submitMailDecision(entry, "decline", status, confirmButton, declineButton);
  });

  actions.append(confirmButton, declineButton);
  bubble.append(header, body, actions, status);
  article.append(avatar, bubble);
  if (insertBeforeNode) {
    messages.insertBefore(article, insertBeforeNode);
  } else {
    messages.append(article);
  }
  scrollToBottom();

  if (persist) {
    appendMailCardEntry(entry.message, entry.runId || "");
  }
}

function ensureMailCard(entry) {
  const history = getSessionHistory();
  const exists = history.some(
    (item) =>
      item &&
      item.type === "mail-card" &&
      item.message === entry.message &&
      (item.runId || "") === (entry.runId || entry.run_id || "")
  );

  if (exists) {
    return;
  }

  createMailCardElement(
    {
      message: entry.message,
      runId: entry.runId || entry.run_id || "",
      decision: "pending",
    },
    true,
    activeStreamingAssistantArticle
  );
}

function formatRelativeDate(timestamp) {
  if (!timestamp) {
    return "";
  }

  try {
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function switchToSession(nextSessionId) {
  if (!nextSessionId || nextSessionId === sessionId) {
    return;
  }

  if (activeRequest) {
    activeRequest.abort();
    activeRequest = null;
  }

  stopStatusPolling();
  activeQuestionTimestamp = null;
  activeRunId = null;
  sessionId = nextSessionId;
  window.localStorage.setItem(STORAGE_KEY, sessionId);
  renderSessionNote();
  renderStoredHistory();
  renderConversationList();
  setBusy(false);
  closeMobileMenu();
  messageInput.focus();
}

function renderConversationList() {
  const historyStore = getHistoryStore();
  const metaStore = getHistoryMetaStore();

  const items = Object.entries(historyStore)
    .filter(([, history]) => Array.isArray(history) && history.length)
    .map(([id, history]) => {
      const meta = metaStore[id] || {};
      const previewEntry =
        history.find(
          (entry) =>
            entry.role === "assistant" &&
            entry.content.trim() &&
            entry.content.trim() !== DEFAULT_ASSISTANT_MESSAGE
        ) ||
        history.find((entry) => entry.role === "user" && entry.content.trim());

      return {
        id,
        label: meta.label || summarizeHistoryLabel(history),
        preview: previewEntry ? previewEntry.content.replace(/\s+/g, " ").trim() : "Noch keine Nachrichten vorhanden.",
        updatedAt: meta.updatedAt || 0,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3);

  historyList.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "Sobald du Unterhaltungen führst, erscheinen hier bis zu drei letzte Verläufe.";
    historyList.append(empty);
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    if (item.id === sessionId) {
      button.classList.add("is-active");
    }

    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = item.label || "Neue Unterhaltung";

    const preview = document.createElement("div");
    preview.className = "history-item-preview";
    preview.textContent = item.preview;

    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = item.id === sessionId ? "Aktuelle Unterhaltung" : formatRelativeDate(item.updatedAt);

    button.append(title, preview, meta);
    button.addEventListener("click", () => {
      switchToSession(item.id);
    });
    historyList.append(button);
  }
}

function createStatusElement() {
  const article = document.createElement("article");
  article.className = "message status";

  const bubble = document.createElement("div");
  bubble.className = "status-bubble";
  bubble.hidden = true;

  const label = document.createElement("div");
  label.className = "status-label";

  const text = document.createElement("div");
  text.className = "status-text";

  const detail = document.createElement("div");
  detail.className = "status-detail";
  detail.hidden = true;

  bubble.append(label, text, detail);
  article.append(bubble);
  messages.append(article);
  scrollToBottom();

  return { article, bubble, label, text, detail };
}

function normalizeStatusEntries(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((entry) => entry && typeof entry === "object");
  }

  if (payload && typeof payload === "object") {
    return [payload];
  }

  return [];
}

function isRenderableToolEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const tool = typeof entry.tool === "string" ? entry.tool.trim() : "";
  if (!tool) {
    return false;
  }

  if (tool.toLowerCase() === "workflow") {
    return false;
  }

  return true;
}

function getStatusSignature(entry) {
  return [
    entry.runId || entry.run_id || "",
    entry.ts || "",
    entry.tool || "",
    entry.label || "",
    entry.status || "",
    entry.message || "",
  ].join("|");
}

function formatStatusLabel(status) {
  switch (status) {
    case "started":
      return "Tool gestartet";
    case "finished":
      return "Tool abgeschlossen";
    case "failed":
      return "Tool fehlgeschlagen";
    default:
      return "Agent-Status";
  }
}

function formatStatusText(entry) {
  if (entry.label) {
    return entry.label;
  }

  if (entry.message) {
    return entry.message;
  }

  if (entry.tool) {
    return `Tool: ${entry.tool}`;
  }

  if (typeof entry.message === "string") {
    return entry.message;
  }

  return "Agent arbeitet gerade an der Antwort.";
}

function formatStatusDetail(entry) {
  if (entry.label && entry.message && entry.label !== entry.message) {
    return entry.message;
  }

  if (!entry.label && entry.tool) {
    return `Tool: ${entry.tool}`;
  }

  return "";
}

function applyStatusUpdate(statusUi, entry) {
  if (entry.tool === "send_mail" && entry.status === "started" && entry.message) {
    statusUi.bubble.hidden = true;
    ensureMailCard(entry);
    return;
  }

  const status = entry.status || "started";
  statusUi.bubble.hidden = false;
  statusUi.bubble.dataset.status = status;
  statusUi.label.textContent = formatStatusLabel(status);
  statusUi.text.textContent = formatStatusText(entry);
  const detail = formatStatusDetail(entry);
  statusUi.detail.hidden = !detail;
  statusUi.detail.textContent = detail;
  scrollToBottom();
}

function stopStatusPolling() {
  if (activeStatusPoller) {
    activeStatusPoller.stop();
    activeStatusPoller = null;
  }
}

function startStatusPolling(statusUi, requestStartedAt, runId) {
  stopStatusPolling();

  let cancelled = false;
  let lastSignature = "";

  const poll = async () => {
    try {
      const params = new URLSearchParams({
        sessionId,
      });

      if (runId) {
        params.set("runId", runId);
      }

      const response = await fetch(`/api/chat-status?${params.toString()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const entries = normalizeStatusEntries(payload);
      if (!entries.length) {
        return;
      }

      const relevantEntries = entries.filter((entry) => {
        if (!entry) {
          return false;
        }

        if (!isRenderableToolEntry(entry)) {
          return false;
        }

        const entryRunId = entry.runId || entry.run_id || "";
        if (runId && entryRunId && entryRunId !== runId) {
          return false;
        }

        if (!entry.ts || !requestStartedAt) {
          return Boolean(entry);
        }

        const entryTime = Date.parse(entry.ts);
        return !Number.isNaN(entryTime) && entryTime >= requestStartedAt;
      });

      if (!relevantEntries.length) {
        return;
      }

      const latestEntry = relevantEntries[relevantEntries.length - 1];
      const signature = getStatusSignature(latestEntry);

      if (signature && signature !== lastSignature) {
        lastSignature = signature;
        applyStatusUpdate(statusUi, latestEntry);
      }
    } catch {
      // Status polling is best-effort and should not interrupt the chat flow.
    }
  };

  poll();
  const intervalId = window.setInterval(() => {
    if (!cancelled) {
      poll();
    }
  }, 700);

  activeStatusPoller = {
    stop() {
      cancelled = true;
      window.clearInterval(intervalId);
      statusUi.bubble.hidden = true;
    },
  };
}

function renderStoredHistory() {
  messages.innerHTML = "";
  const history = getSessionHistory();

  if (!history.length) {
    createMessageElement("assistant", DEFAULT_ASSISTANT_MESSAGE, false, true);
    return;
  }

  for (const entry of history) {
    if (entry && entry.type === "mail-card" && typeof entry.message === "string") {
      createMailCardElement(entry, false);
      continue;
    }

    if (!entry || typeof entry.content !== "string" || !entry.content.trim()) {
      continue;
    }

    createMessageElement(entry.role === "user" ? "user" : "assistant", entry.content, false, false);
  }

  scrollToBottom();
}

function extractDisplayText(payload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidates = [
    payload.output,
    payload.text,
    payload.content,
    payload.message,
    payload.delta,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function collectJsonObjects(buffer) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(buffer.slice(start, index + 1));
        start = -1;
      }
    }
  }

  const remainder = depth === 0 ? "" : buffer.slice(start);
  return { objects, remainder };
}

function normalizeStreamChunk(chunk, state) {
  state.buffer += chunk;
  const { objects, remainder } = collectJsonObjects(state.buffer);
  state.buffer = remainder;

  if (!objects.length) {
    state.rawText += chunk;
    return "";
  }

  let delta = "";

  for (const rawObject of objects) {
    let parsed;

    try {
      parsed = JSON.parse(rawObject);
    } catch {
      continue;
    }

    if (parsed.type === "item") {
      let content = parsed.content;

      if (
        typeof content === "string" &&
        /^[\[{"]/.test(content.trim())
      ) {
        try {
          content = JSON.parse(content);
        } catch {
          // Keep the raw string when content isn't JSON.
        }
      }

      delta += extractDisplayText(content);
    }
  }

  if (delta) {
    state.sawStructuredEvents = true;
  }

  return delta;
}

async function streamAssistantReply(message) {
  activeRequest = new AbortController();
  activeQuestionTimestamp = Date.now();
  activeRunId = createRunId();

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      sessionId,
      runId: activeRunId,
      metadata: {
        source: "wifa-chat-ui",
      },
    }),
    signal: activeRequest.signal,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(errorText || "Die Antwort vom Server war nicht erfolgreich.");
  }
  const assistantBubble = createMessageElement("assistant", "", true);
  activeStreamingAssistantArticle = assistantBubble._article;
  const statusUi = createStatusElement();
  startStatusPolling(statusUi, activeQuestionTimestamp, activeRunId);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {
    buffer: "",
    rawText: "",
    sawStructuredEvents: false,
  };

  let assistantText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    const delta = normalizeStreamChunk(chunk, state);

    if (delta) {
      assistantText += delta;
      setBubbleContent(assistantBubble, "assistant", assistantText);
      scrollToBottom();
    }
  }

  const trailingText = decoder.decode();
  if (trailingText) {
    const delta = normalizeStreamChunk(trailingText, state);
    if (delta) {
      assistantText += delta;
    }
  }

  if (!stripThoughtBlocks(assistantText).trim()) {
    const fallback = state.sawStructuredEvents ? state.buffer : state.rawText + state.buffer;
    assistantText = fallback.trim();
  }

  const finalAssistantText =
    stripThoughtBlocks(assistantText).trim() ||
    "Keine Antwort erhalten. Bitte prüfe den n8n-Workflow.";

  setBubbleContent(
    assistantBubble,
    "assistant",
    finalAssistantText
  );
  assistantBubble.classList.remove("streaming");
  appendHistoryEntry("assistant", finalAssistantText);
  stopStatusPolling();
  activeQuestionTimestamp = null;
  activeStreamingAssistantArticle = null;
  activeRunId = null;
  scrollToBottom();
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = messageInput.value.trim();
  if (!message) {
    return;
  }

  createMessageElement("user", message);
  messageInput.value = "";
  autoResizeTextarea();
  setBusy(true, "Der Assistent antwortet gerade ...");

  try {
    await streamAssistantReply(message);
    setBusy(false, "Bereit für die nächste Frage.");
    messageInput.focus();
  } catch (error) {
    stopStatusPolling();
    activeQuestionTimestamp = null;
    activeStreamingAssistantArticle = null;
    activeRunId = null;
    createMessageElement(
      "assistant",
      "Es gab ein Problem beim Verbinden mit dem n8n-Agenten. Bitte prüfe den Webhook und die Streaming-Konfiguration."
    );
    setBusy(false, "Verbindung fehlgeschlagen.");
    console.error(error);
  } finally {
    activeRequest = null;
  }
});

messageInput.addEventListener("input", autoResizeTextarea);

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

resetButton.addEventListener("click", () => {
  if (activeRequest) {
    activeRequest.abort();
    activeRequest = null;
  }

  stopStatusPolling();
  activeQuestionTimestamp = null;
  activeStreamingAssistantArticle = null;
  activeRunId = null;
  resetSession();
  setBusy(false, "Neue Unterhaltung aktiv.");
  messageInput.focus();
});

mobileMenuButton?.addEventListener("click", () => {
  const isOpen = document.body.classList.contains("mobile-menu-open");
  if (isOpen) {
    closeMobileMenu();
    return;
  }

  openMobileMenu();
});

mobileCloseButton?.addEventListener("click", closeMobileMenu);
mobileNavBackdrop?.addEventListener("click", closeMobileMenu);

sidebar?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest(".quick-link")) {
    closeMobileMenu();
  }
});

window.addEventListener("resize", () => {
  if (!isMobileViewport()) {
    closeMobileMenu();
  }
});

autoResizeTextarea();
renderSessionNote();
renderStoredHistory();
renderConversationList();
closeMobileMenu();
