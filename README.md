# NIGHT Estimator (fee-estimator-3)

How much NIGHT does a DApp have to hold to sponsor its users' DUST fees
indefinitely? This is the third version of the estimator, and the first one
built on measured data rather than a handful of explorer readings.

Predecessors: `../night-estimator` (the deployed v1 at night-estimator.vercel.app,
five calibration points), `../fee-estimator` (Compact fee benchmarks) and
`../fee-estimator-2` (indexer probe, fleet monitor, capacity planner).

## What changed from v1

| | v1 (night-estimator) | v3 (this) |
|---|---|---|
| Fee model | two tiers, 0.30 / ~0.67 DUST, +0.004 per write | the ledger's own formula on measured five-dimension costs |
| Calibration | 5 explorer readings, preprod | 1,334 transactions costed with `Transaction.cost(params)` on mainnet, preview and stagenet |
| Price | fixed multipliers per "congestion level" (4×, 10×) | the actual controller: `1 + logit(fullness)/100` per block, floor of 10 on ledger 9 |
| Block size | 200,000 B | 1,000,000 B (live parameter; the 200,000 was the genesis default) |
| Transfers | 0.30 DUST | 0.26 DUST guaranteed segment, 0.55 DUST fallible segment — the segment doubles the write cost |
| Contract calls | "±3% regardless of complexity" | 0.12 – 1.16 DUST on stagenet; state writes, not the proof, drive the spread |

## Run

```bash
npm install
npm run test       # fee model reproduces every stagenet preset within 2.5%
npm run dev        # http://localhost:5173
npm run build      # dist/ for Vercel or any static host
```

## Data

`data/*.jsonl` holds every regular transaction in the last 6,000 blocks of each
network on 3 September 2026, rebuilt with the matching ledger library
(`@midnight-ntwrk/ledger-v8` for mainnet and preview, `@midnightntwrk/ledger-v9`
for stagenet) and costed against that network's live `ledgerParameters`. Each
row carries the five absolute costs, their fraction of the block limits, the fee
the chain charged, and the block height and hash.

`npm run presets` rebuilds `src/presets.json` from that data. Each preset is one
real transaction (or the median of a family), stored as five fractions of the
block limits. The fee is never stored; `src/model.js` computes it at run time
from the fractions and the chosen price, so the price scenario re-prices every
preset consistently.

The scan scripts that produced the data live in `../load-test`
(`decompose_v8.mjs`, `stagenet/decompose_all.mjs`, `netparams.mjs`).

## The model

Fee, from `base-crypto/src/cost_model.rs`:

```
fee_DUST = overall_price × ( max(f_read·read, f_compute·compute, f_size·size)
                            + f_write·(bytes_written + bytes_churned) )
```

with every cost a fraction of its block limit (2.000 s, 2.000 s, 1,000,000 B,
50,000 B, 50,000,000 B). The four factors were 0.571 / 0.571 / 0.574 / 2.284 on
stagenet at block 305,299; they drift slowly, and treating them as fixed is why
modeled and charged fees differ by up to about 2%.

DUST, from `ledger/src/dust.rs`: one NIGHT backs 5 DUST of capacity and
generates 8,267 SPECK per STAR per second, i.e. 0.7143 DUST per NIGHT per day;
an empty reservoir fills in 7.0 days. Generation stops at the cap and resumes
when DUST is spent, so **NIGHT held × 0.7143 is the most DUST a sponsor can burn
per day forever.** The infinite-runway holding is `daily_burn / 0.7143`, plus a
buffer. A full reservoir additionally absorbs peaks above the generation rate.

Price, from `price_adjustment_function`: after each block the price is multiplied
by `1 + logit(u)/100`, `u` clamped to [0.01, 0.99]. Neutral at 50% full,
+4.60% per block at 99%, −4.60% at 1%. No ceiling. Ledger 9 adds a
`min_block_price` of 10; ledger 8 (mainnet, preview today) has a floor of
5.42×10⁻¹⁸, which is why every mainnet transaction costs 1 SPECK.

## Two things the estimator says that v1 did not

- **Mainnet sponsorship is free today.** Every transaction costs 1 SPECK. The
  estimator prices at the ledger-9 floor of 10 because that is what stagenet
  charges now and what mainnet will charge after the upgrade.
- **Concurrency is wallet count.** With the current wallet SDK, building a
  transaction moves all of a wallet's DUST to pending, so a wallet has exactly
  one transaction in flight. Peak tx/s × seconds in flight = wallets needed.

## Limits

Ledger-level costs only. Proving time, proof-server capacity and mempool ingest
(measured at 1.9 tx/s for a single client on preview) are not modeled beyond
the "seconds in flight" input. The per-dimension fee factors are a snapshot.
The heavy-state and mainnet-call presets come from mainnet, where they were
charged 1 SPECK; their floor-price fee is modeled, not observed.
