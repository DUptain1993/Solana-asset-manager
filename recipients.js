import { PublicKey } from "@solana/web3.js";

export function parseRecipients(env) {
  const single = (env.RECIPIENT || "").trim();
  const multi = (env.RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = multi.length > 0 ? multi : single ? [single] : [];
  if (list.length === 0) throw new Error("no recipient configured");
  for (const r of list) {
    try { new PublicKey(r); } catch { throw new Error(`invalid recipient: ${r}`); }
  }
  return list;
}

export function assignEntries(entries, recipients) {
  // Round-robin assign sorted entries across recipients.
  const buckets = recipients.map(() => []);
  entries.forEach((entry, i) => {
    buckets[i % recipients.length].push(entry);
  });
  return buckets;
}

export function splitLamports(total, recipients) {
  const n = BigInt(recipients.length);
  const per = total / n;
  const remainder = total - per * n;
  const out = recipients.map((r, i) => (i === 0 ? per + remainder : per));
  return out;
}
