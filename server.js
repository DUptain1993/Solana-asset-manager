import http from "node:http";
import crypto from "node:crypto";
import "dotenv/config";
import { buildPlan, submitSigned, makeConnection } from "./core.js";
import { loadAltAuthority, ensureAlt, defaultAltAddresses } from "./alt.js";
import { parseRecipients } from "./recipients.js";
import * as store from "./store.js";
import * as ratelimit from "./ratelimit.js";

const PORT = Number(process.env.PORT || 3000);
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const DAS_URL = process.env.DAS_RPC_URL || null;
const PRIORITY = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 100000);
const PRIORITY_MODE = process.env.PRIORITY_FEE_MODE || "dynamic";
const UNIT_LIMIT = process.env.UNIT_LIMIT ? Number(process.env.UNIT_LIMIT) : null;
const USE_JITO = process.env.USE_JITO === "true";
const JITO_TIP = Number(process.env.JITO_TIP_LAMPORTS || 100000);
const SIMULATE = process.env.SIMULATE_BEFORE_PLAN !== "false";
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== "false";
const ENABLE_ALT = process.env.ENABLE_ALT !== "false";
const ENABLE_CNFT = process.env.ENABLE_CNFT !== "false";
const MAX_CNFT = Number(process.env.MAX_CNFT_SWEEP || 10);

const RECIPIENTS = parseRecipients(process.env);
const RECIPIENT_SET = new Set(RECIPIENTS);

const connection = makeConnection(RPC);
const altAuthority = ENABLE_ALT ? loadAltAuthority() : null;

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
}

function verifyAuth(body, secret) {
  if (!REQUIRE_AUTH) return true;
  if (!secret) return true;
  const provided = body.auth;
  if (!provided) return false;
  const { auth, ...rest } = body;
  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(rest)).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function ensureCampaignAlt(campaign) {
  if (!ENABLE_ALT || !altAuthority) return null;
  const addresses = defaultAltAddresses(RECIPIENTS);
  try {
    const { address, account } = await ensureAlt(connection, altAuthority, campaign.alt, addresses);
    if (address !== campaign.alt) store.update(campaign.id, { alt: address });
    return account;
  } catch (err) {
    console.error("[alt] ensure failed:", err.message);
    return null;
  }
}

async function handlePlan(req, res) {
  const ip = clientIp(req);
  if (!ratelimit.allow(ip)) return json(res, 429, { error: "rate limited" });

  const body = await readBody(req);
  if (!body.source || !body.recipient) return json(res, 400, { error: "source and recipient required" });

  const campaign = body.campaignId ? store.get(body.campaignId) : null;
  if (REQUIRE_AUTH && campaign?.secret && !verifyAuth(body, campaign.secret)) {
    return json(res, 401, { error: "unauthorized" });
  }

  // Enforce recipient set.
  const requestedRecipients = Array.isArray(body.recipients) && body.recipients.length
    ? body.recipients
    : [body.recipient];
  for (const r of requestedRecipients) {
    if (!RECIPIENT_SET.has(r)) return json(res, 400, { error: `recipient not allowed: ${r}` });
  }

  const altAccount = campaign ? await ensureCampaignAlt({ ...campaign, id: body.campaignId }) : null;

  try {
    const plan = await buildPlan({
      rpc: RPC,
      source: body.source,
      recipients: requestedRecipients,
      mode: body.mode,
      liquidMints: body.liquidMints,
      priorityMicroLamports: PRIORITY,
      priorityMode: PRIORITY_MODE,
      unitLimit: UNIT_LIMIT,
      altAccount,
      useJito: USE_JITO,
      jitoTipLamports: JITO_TIP,
      simulate: SIMULATE,
      includeCnft: ENABLE_CNFT,
      dasUrl: DAS_URL,
      maxCnft: MAX_CNFT,
    });

    log("plan", {
      ip,
      source: body.source,
      tokens: plan.tokenCount,
      splTxs: plan.transactions.length,
      cnftTxs: plan.cnftTransactions.length,
      closes: plan.closeCount,
      alt: !!altAccount,
    });

    json(res, 200, {
      planId: `${body.source}:${body.mode || "auto"}:${Date.now().toString(36)}`,
      source: body.source,
      recipients: plan.recipients,
      mode: body.mode || "auto",
      useVersioned: true,
      useJito: plan.useJito,
      jitoTip: plan.jitoTip,
      transactions: plan.transactions,
      txMeta: plan.txMeta,
      cnftTransactions: plan.cnftTransactions,
      cnftMeta: plan.cnftMeta,
      cnftTotal: plan.cnftTotal,
      cnftSkipped: plan.cnftSkipped,
      tokenCount: plan.tokenCount,
      closeCount: plan.closeCount,
      solLamports: plan.solLamports,
      settableLamports: plan.settableLamports,
      priorityMicroLamports: plan.priorityMicroLamports,
    });
  } catch (err) {
    log("plan.error", { ip, error: err.message });
    json(res, 500, { error: err.message });
  }
}

async function handleSubmit(req, res) {
  const ip = clientIp(req);
  if (!ratelimit.allow(ip)) return json(res, 429, { error: "rate limited" });

  const body = await readBody(req);
  if (!Array.isArray(body.signedTransactions)) {
    return json(res, 400, { error: "signedTransactions required" });
  }

  const campaign = body.campaignId ? store.get(body.campaignId) : null;
  if (REQUIRE_AUTH && campaign?.secret && !verifyAuth(body, campaign.secret)) {
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    const result = await submitSigned({
      rpc: RPC,
      signedTransactions: body.signedTransactions,
      signedCnftTransactions: body.signedCnftTransactions || [],
      jitoTipBase64: body.jitoTipBase64,
      useJito: USE_JITO && !!body.jitoTipBase64,
    });
    log("submit", {
      ip,
      ok: result.complete,
      sigs: result.signatures.length,
      failed: result.failed.length,
      bundleId: result.bundleId,
    });
    json(res, 200, result);
  } catch (err) {
    log("submit.error", { ip, error: err.message });
    json(res, 500, { error: err.message });
  }
}

function log(event, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }
  try {
    if (req.method === "POST" && req.url === "/plan") return await handlePlan(req, res);
    if (req.method === "POST" && req.url === "/submit") return await handleSubmit(req, res);
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, alt: ENABLE_ALT, cnft: ENABLE_CNFT });
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => log("start", { port: PORT, recipients: RECIPIENTS, alt: !!altAuthority, cnft: ENABLE_CNFT }));
