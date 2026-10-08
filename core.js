import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  createTransferCheckedWithFeeInstruction,
  calculateFee,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import { planCompressedSweep } from "./cnft.js";
import { assignEntries, splitLamports } from "./recipients.js";

const SIGNATURE_FEE = 5000;
const BASE_TX_CU = 20000;
const CU_PER_TRANSFER = 30000;
const CU_PER_CLOSE = 8000;
const CU_PER_ATA = 25000;
const CU_PER_CNFT = 200000;
const MAX_TRANSFERS_PER_TX = 12;
const MAX_CLOSES_PER_TX = 10;
const MIN_PRIORITY = 1000;
const MAX_PRIORITY = 5_000_000;
const MAX_UNIT_LIMIT = 1_400_000;

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

const JITO_ENDPOINT = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

export function keypairFromSecret(value, name) {
  if (!value) throw new Error(`${name} is not configured`);
  let bytes;
  try {
    bytes = value.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(value))
      : bs58.decode(value.trim());
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`${name} must contain 32 or 64 bytes`);
}

export function makeConnection(rpcUrl) {
  return new Connection(rpcUrl || "https://api.mainnet-beta.solana.com", "confirmed");
}

async function scan(connection, owner) {
  const lamports = await connection.getBalance(owner, "confirmed");
  const grouped = new Map();

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const entry of accounts.value) {
      const info = entry.account.data.parsed.info;
      const prior = grouped.get(info.mint);
      grouped.set(info.mint, {
        raw: (prior ? prior.raw : 0n) + BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        account: entry.pubkey.toBase58(),
        program: entry.account.owner.toBase58(),
        frozen: info.state === "frozen",
      });
    }
  }
  return { lamports, grouped };
}

async function emptyAccounts(connection, owner) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const entry of accounts.value) {
      if (BigInt(entry.account.data.parsed.info.tokenAmount.amount) === 0n) {
        out.push({ account: entry.pubkey, program: programId });
      }
    }
  }
  return out;
}

function tokenProgramOf(entry) {
  return entry.program === TOKEN_2022_PROGRAM_ID.toBase58()
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

export async function suggestPriorityFee(connection, mode, fallback) {
  if (mode === "fixed") return fallback;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return fallback;
    const sorted = fees.map((f) => f.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    if (!sorted.length) return fallback;
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, p75));
  } catch {
    return fallback;
  }
}

function estimateUnits(transfers, closes, cnfts = 0) {
  const ataCost = transfers * CU_PER_ATA;
  const transferCost = transfers * CU_PER_TRANSFER;
  const closeCost = closes * CU_PER_CLOSE;
  const cnftCost = cnfts * CU_PER_CNFT;
  return Math.min(MAX_UNIT_LIMIT, BASE_TX_CU + ataCost + transferCost + closeCost + cnftCost);
}

async function transferInstruction(connection, entry, destination, owner) {
  const mint = new PublicKey(entry.mint);
  const source = new PublicKey(entry.account);
  const program = tokenProgramOf(entry);

  if (program.equals(TOKEN_PROGRAM_ID)) {
    return createTransferCheckedInstruction(
      source, mint, destination, owner, entry.raw, entry.decimals, [], TOKEN_PROGRAM_ID,
    );
  }

  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = mintInfo.transferFeeConfig;
  if (!feeConfig) {
    return createTransferCheckedInstruction(
      source, mint, destination, owner, entry.raw, entry.decimals, [], TOKEN_2022_PROGRAM_ID,
    );
  }
  const fee = calculateFee(feeConfig.newerTransferFee, entry.raw);
  return createTransferCheckedWithFeeInstruction(
    source, mint, destination, owner, entry.raw, entry.decimals, fee, [], TOKEN_2022_PROGRAM_ID,
  );
}

async function buildV0(connection, payer, instructions, altAccounts) {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(altAccounts || []);
  return new VersionedTransaction(message);
}

async function simulate(connection, tx) {
  try {
    const res = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    return { ok: !res.value.err, err: res.value.err, logs: res.value.logs || [] };
  } catch (err) {
    return { ok: false, err: err.message, logs: [] };
  }
}

/**
 * Build the full plan.
 *
 * recipients      — array of recipient base58 strings
 * altAccount      — AddressLookupTableAccount | null
 * source          — base58
 * includeCnft     — bool
 * dasUrl          — DAS RPC URL for compressed asset lookup
 */
export async function buildPlan({
  rpc,
  source,
  recipients,
  mode,
  liquidMints,
  priorityMicroLamports,
  priorityMode = "dynamic",
  unitLimit,
  altAccount,
  useJito = false,
  jitoTipLamports = 100000,
  simulate: doSimulate = true,
  includeCnft = false,
  dasUrl = null,
  maxCnft = 10,
}) {
  const connection = makeConnection(rpc);
  const sourceKey = new PublicKey(source);
  const recipientKeys = recipients.map((r) => new PublicKey(r));
  const recipientSet = new Set(recipients);
  if (recipientSet.has(source)) throw new Error("source and recipient must differ");

  const { lamports, grouped } = await scan(connection, sourceKey);
  const manual = mode === "manual";
  const allowlist = manual ? new Set(liquidMints || []) : null;

  const entries = [];
  for (const [mint, entry] of grouped) {
    if (entry.raw <= 0n) continue;
    if (entry.frozen) continue;
    if (allowlist && !allowlist.has(mint)) continue;
    entries.push({ mint, ...entry });
  }
  entries.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));

  const closable = await emptyAccounts(connection, sourceKey);

  const priority = await suggestPriorityFee(connection, priorityMode, priorityMicroLamports);

  // ---- cNFT sweep (parallel, one tx per asset, tracked separately) ----
  let cnftPlan = { assets: [], instructions: [], total: 0, selected: 0 };
  if (includeCnft && dasUrl) {
    cnftPlan = await planCompressedSweep({
      rpcUrl: rpc,
      dasUrl,
      source,
      recipient: recipients[0],
      maxAssets: maxCnft,
    });
  }
  const cnftTxs = [];

  // ---- SPL + SOL plan ----
  const buckets = assignEntries(entries, recipients);
  const lamportsPerRecipient = splitLamports(BigInt(lamports), recipients);

  // Compute total fee reserve: token chunks + close chunks + cnft txs + jito tip.
  const tokenChunks = Math.max(1, Math.ceil(entries.length / MAX_TRANSFERS_PER_TX));
  const closeChunks = Math.max(1, Math.ceil(closable.length / MAX_CLOSES_PER_TX));
  const splIterations = Math.max(tokenChunks, closeChunks);

  let reserve = 0n;
  for (let i = 0; i < splIterations; i++) {
    const t = Math.min(MAX_TRANSFERS_PER_TX, Math.max(0, entries.length - i * MAX_TRANSFERS_PER_TX));
    const c = Math.min(MAX_CLOSES_PER_TX, Math.max(0, closable.length - i * MAX_CLOSES_PER_TX));
    const cu = unitLimit || estimateUnits(t, c);
    reserve += BigInt(SIGNATURE_FEE + Math.ceil((priority * cu) / 1_000_000));
  }
  for (const _ of cnftPlan.instructions) {
    reserve += BigInt(SIGNATURE_FEE + Math.ceil((priority * CU_PER_CNFT) / 1_000_000));
  }
  if (useJito) reserve += BigInt(jitoTipLamports + SIGNATURE_FEE);

  if (BigInt(lamports) < reserve) {
    throw new Error(`insufficient SOL for fees: have ${lamports}, need ${reserve}`);
  }

  const settablePerRecipient = !manual
    ? recipients.map((r) => {
        const base = lamportsPerRecipient[recipients.indexOf(r)];
        return base > reserve / BigInt(recipients.length) ? base - reserve / BigInt(recipients.length) : 0n;
      })
    : recipients.map(() => 0n);

  const builtTxs = [];

  for (let i = 0; i < splIterations; i++) {
    // Slice globally, then distribute each slice per recipient.
    const globalChunk = entries.slice(i * MAX_TRANSFERS_PER_TX, (i + 1) * MAX_TRANSFERS_PER_TX);
    const closes = closable.slice(i * MAX_CLOSES_PER_TX, (i + 1) * MAX_CLOSES_PER_TX);
    if (globalChunk.length === 0 && closes.length === 0 && (i !== 0 || settablePerRecipient.some((s) => s > 0n))) {
      // no-op
    }
    if (globalChunk.length === 0 && closes.length === 0 && i !== 0) continue;
    if (globalChunk.length === 0 && closes.length === 0 && settablePerRecipient.every((s) => s === 0n) && i === 0) {
      // continue — we still want to attempt closes if any
      if (closes.length === 0) continue;
    }

    const cu = unitLimit || estimateUnits(globalChunk.length, closes.length);
    const instructions = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
    ];

    if (i === 0) {
      for (let r = 0; r < recipients.length; r++) {
        const amount = settablePerRecipient[r];
        if (amount <= 0n) continue;
        instructions.push(SystemProgram.transfer({
          fromPubkey: sourceKey,
          toPubkey: recipientKeys[r],
          lamports: Number(amount),
        }));
      }
    }

    for (const entry of globalChunk) {
      const recipientIdx = globalChunk.indexOf(entry) % recipients.length;
      const recipientKey = recipientKeys[recipientIdx];
      const program = tokenProgramOf(entry);
      const destination = getAssociatedTokenAddressSync(
        new PublicKey(entry.mint), recipientKey, false, program,
      );
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(
        sourceKey, destination, recipientKey, new PublicKey(entry.mint), program,
      ));
      instructions.push(await transferInstruction(connection, entry, destination, sourceKey));
    }

    for (const { account, program } of closes) {
      instructions.push(createCloseAccountInstruction(
        account, recipientKeys[0], sourceKey, [], program,
      ));
    }

    const tx = await buildV0(connection, sourceKey, instructions, altAccount ? [altAccount] : []);
    const serialized = Buffer.from(tx.serialize()).toString("base64");

    if (doSimulate) {
      const sim = await simulate(connection, tx);
      builtTxs.push({ base64: serialized, simulated: sim.ok, simError: sim.ok ? null : sim.err });
      continue;
    }
    builtTxs.push({ base64: serialized, simulated: null });
  }

  // ---- cNFT txs ----
  for (const asset of cnftPlan.instructions) {
    const instructions = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(MAX_UNIT_LIMIT, CU_PER_CNFT) }),
      ...asset.instructions,
    ];
    const tx = await buildV0(connection, sourceKey, instructions, altAccount ? [altAccount] : []);
    const serialized = Buffer.from(tx.serialize()).toString("base64");

    let simulated = null;
    let simError = null;
    if (doSimulate) {
      const sim = await simulate(connection, tx);
      simulated = sim.ok;
      simError = sim.ok ? null : sim.err;
    }
    cnftTxs.push({ base64: serialized, assetId: asset.assetId, name: asset.name, simulated, simError });
  }

  // ---- Jito tip ----
  let jitoTip = null;
  if (useJito) {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipIx = SystemProgram.transfer({
      fromPubkey: sourceKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: jitoTipLamports,
    });
    const tipTx = await buildV0(connection, sourceKey, [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 5000 }),
      tipIx,
    ], altAccount ? [altAccount] : []);
    jitoTip = {
      base64: Buffer.from(tipTx.serialize()).toString("base64"),
      tipAccount,
      lamports: jitoTipLamports,
    };
  }

  const cnftSkipped = cnftPlan.assets.filter((a) => a.error);

  return {
    transactions: builtTxs.map((t) => t.base64),
    txMeta: builtTxs,
    cnftTransactions: cnftTxs.map((t) => t.base64),
    cnftMeta: cnftTxs,
    cnftSkipped,
    cnftTotal: cnftPlan.total,
    jitoTip,
    useVersioned: true,
    tokenCount: entries.length,
    closeCount: closable.length,
    solLamports: String(lamports),
    settableLamports: settablePerRecipient.map(String),
    recipients,
    priorityMicroLamports: priority,
    iterations: splIterations,
    useJito,
  };
}

export async function submitSigned({
  rpc,
  signedTransactions,
  signedCnftTransactions = [],
  jitoTipBase64,
  useJito = false,
}) {
  const connection = makeConnection(rpc);

  if (useJito && jitoTipBase64) {
    return submitViaJito([...signedTransactions, ...signedCnftTransactions], jitoTipBase64, connection);
  }

  const all = [...signedTransactions, ...signedCnftTransactions];
  const results = await Promise.allSettled(
    all.map((b64, i) => broadcastOne(connection, b64, i)),
  );

  const signatures = [];
  const failed = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.signature) signatures.push(r.value.signature);
    else failed.push({
      index: r.status === "fulfilled" ? r.value.index : -1,
      error: r.status === "fulfilled" ? r.value.error : r.reason?.message || "unknown",
    });
  }

  return {
    signatures,
    failed,
    complete: failed.length === 0 && signatures.length === all.length,
    total: all.length,
  };
}

async function broadcastOne(connection, b64, index) {
  let tx;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  } catch {
    return { index, error: "malformed" };
  }
  const required = tx.message.header.numRequiredSignatures;
  const signed = tx.signatures.filter((s) => s.some((b) => b !== 0)).length;
  if (signed < required) {
    return { index, error: `missing signatures ${signed}/${required}` };
  }
  try {
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const ok = await confirm(connection, signature, tx);
    if (ok) return { index, signature };
    return { index, error: "not confirmed", signature };
  } catch (err) {
    return { index, error: err.message };
  }
}

async function submitViaJito(signedTxs, jitoTipBase64, connection) {
  const all = [...signedTxs, jitoTipBase64];
  const res = await fetch(JITO_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [all],
    }),
  });
  const data = await res.json();
  if (data.error) {
    return {
      signatures: [],
      failed: [{ index: -1, error: data.error.message || "jito rejected" }],
      complete: false,
      bundleId: null,
      total: all.length,
    };
  }
  const bundleId = data.result;
  const confirmed = await confirmBundle(bundleId);
  return {
    signatures: confirmed.signatures || [],
    failed: confirmed.signatures?.length === all.length ? [] : [{ index: -1, error: "bundle not fully confirmed" }],
    complete: confirmed.signatures?.length === all.length,
    bundleId,
    total: all.length,
  };
}

async function confirmBundle(bundleId) {
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const res = await fetch(JITO_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
      });
      const data = await res.json();
      const status = data.result?.value?.[0];
      if (status && status.confirmation_status === "confirmed") {
        return { signatures: status.transactions || [] };
      }
    } catch {}
    if (Date.now() >= deadline) return { signatures: [] };
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function confirm(connection, signature, tx) {
  const deadline = Date.now() + 45000;
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const res = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (res.value.err) return false;
    return true;
  } catch {}
  // Fallback: poll.
  let delay = 500;
  for (;;) {
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (status.value?.confirmationStatus === "confirmed") return status.value.err === null;
      if (status.value?.err) return false;
    } catch {}
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(3000, Math.floor(delay * 1.4));
  }
}
