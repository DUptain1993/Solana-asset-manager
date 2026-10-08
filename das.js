import bs58 from "bs58";

async function dasCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "das", method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`DAS ${method}: ${data.error.message || "failed"}`);
  return data.result;
}

export async function listCompressedAssets(rpcUrl, owner, limit = 1000) {
  const result = await dasCall(rpcUrl, "getAssetsByOwner", {
    ownerAddress: owner,
    page: 1,
    limit,
    displayOptions: { showFungible: false, showNativeBalance: false },
  });
  return (result.items || []).filter((a) => a.compression?.compressed === true);
}

export async function getAssetProof(rpcUrl, assetId) {
  return await dasCall(rpcUrl, "getAssetProof", { id: assetId });
}

export function decodeProof(proof) {
  return {
    root: bs58.decode(proof.root),
    proof: (proof.proof || []).map((p) => bs58.decode(p)),
    treeId: proof.tree_id,
    leaf: proof.leaf,
    nodeIndex: proof.node_index,
  };
}

export function decodeHash(hexOrB58, expectedLen = 32) {
  // DAS returns data_hash/creator_hash as base58 strings in most providers.
  try {
    const decoded = bs58.decode(hexOrB58);
    if (decoded.length === expectedLen) return decoded;
  } catch {}
  // Fallback: hex.
  if (/^[0-9a-fA-F]+$/.test(hexOrB58) && hexOrB58.length === expectedLen * 2) {
    return Uint8Array.from(Buffer.from(hexOrB58, "hex"));
  }
  throw new Error(`cannot decode hash: ${hexOrB58}`);
}
