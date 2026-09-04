// derive_presets.mjs -- build src/presets.json from the measured cost
// decompositions in data/. Every preset is one real transaction (or the median
// of a family of them), identified by network, block height and serialized size,
// with its five cost dimensions as fractions of the block limits.
//
// The fee is NOT stored here. It is computed at run time by src/model.js from
// the dimensions, so that changing the price scenario re-prices every preset
// consistently.
//
// Usage: node scripts/derive_presets.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DIMS = ['read_time', 'compute_time', 'block_usage', 'bytes_written', 'bytes_churned'];

const load = (file, net) =>
  readFileSync(join(here, '..', 'data', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.pct)
    .map((r) => ({ ...r, net: r.net ?? net }));

const rows = [
  ...load('shapes_mainnet.jsonl', 'mainnet'),
  ...load('shapes_preview.jsonl', 'preview'),
  ...load('shapes_stagenet.jsonl', 'stagenet'),
  ...load('shapes_ours.jsonl', 'stagenet'),
];

const one = (pred, label) => {
  const r = rows.find(pred);
  if (!r) throw new Error(`no row for ${label}`);
  return r;
};
const medianBy = (list, key) => {
  const s = [...list].sort((a, b) => key(a) - key(b));
  return s[Math.floor(s.length / 2)];
};

const frac = (r) => Object.fromEntries(DIMS.map((d) => [d, r.pct[d] / 100]));
const preset = (id, label, group, r, extra = {}) => ({
  id,
  label,
  group,
  source: { net: r.net, height: r.height, hash: r.hash, bytes: r.bytes, bytesWritten: r.abs.bytes_written, kind: r.kind },
  frac: frac(r),
  ...extra,
});

const stagenetCalls = rows.filter((r) => r.net === 'stagenet' && r.kind === 'ContractCall' && !r.ours);
const stagenetDeploys = rows.filter((r) => r.net === 'stagenet' && r.kind === 'ContractDeploy');

const presets = [
  preset('transfer_guaranteed', 'Unshielded transfer (guaranteed segment)', 'transfer',
    one((r) => r.net === 'mainnet' && r.kind === 'transfer' && r.bytes === 3806, 'transfer_guaranteed'),
    { note: '1 input, 2 outputs, one DUST spend. The shape the mainnet wallet builds.' }),
  preset('transfer_fallible', 'Unshielded transfer (fallible segment)', 'transfer',
    one((r) => r.net === 'stagenet' && r.kind === 'transfer' && r.bytes === 3820, 'transfer_fallible'),
    { note: 'Same transfer built in the fallible segment, as the preview and stagenet wallets do. Writes twice as much state.' }),
  preset('batch_payout_40', 'Batch payout, 40 recipients', 'transfer',
    one((r) => r.net === 'stagenet' && r.kind === 'transfer' && r.bytes === 4185, 'batch_payout_40'),
    { recipients: 40, note: '4 inputs to 40 outputs in one transaction. Fee shown per transaction; divide by 40 per recipient.' }),
  preset('dust_registration', 'DUST registration', 'setup',
    one((r) => r.net === 'stagenet' && r.kind === 'transfer' && r.bytes === 715, 'dust_registration'),
    { note: 'One-time per NIGHT UTXO before it can generate DUST. 1 input, 1 output.' }),
  preset('call_light', 'Contract call, light', 'contract',
    one((r) => r.net === 'stagenet' && r.kind === 'ContractCall' && r.bytes === 7157, 'call_light'),
    { note: 'The cheapest call family on stagenet: one proof, 324 B of state written.' }),
  preset('call_typical', 'Contract call, typical', 'contract',
    medianBy(stagenetCalls, (r) => Number(r.fee)),
    { note: 'Median-fee contract call across 314 third-party calls on stagenet.' }),
  preset('call_mainnet', 'Contract call, mainnet’s dominant contract', 'contract',
    one((r) => r.net === 'mainnet' && r.kind === 'ContractCall' && r.bytes === 8275, 'call_mainnet'),
    { note: '111 of the last 112 fee-paying mainnet transactions were calls to this contract.' }),
  preset('call_heavy_state', 'Contract call, heavy state write', 'contract',
    one((r) => r.net === 'mainnet' && r.kind === 'ContractCall' && r.bytes === 7727, 'call_heavy_state'),
    { note: 'A mainnet call that writes 5.9 KB of contract state. Writes, not the proof, set its fee.' }),
  preset('shielded_transfer_2', 'Shielded transfer, 2 outputs', 'transfer',
    one((r) => r.net === 'stagenet' && r.kind === 'transfer' && r.bytes === 71582, 'shielded_transfer_2'),
    { note: 'User-created shielded token, 2 outputs. Shielded proofs are ~70 KB.' }),
  preset('deploy', 'Contract deployment', 'contract',
    medianBy(stagenetDeploys, (r) => Number(r.fee)),
    { note: 'Median of 99 stagenet deployments. Writes roughly its own size into state.' }),
];

// Sanity: the fee the chain actually charged for each source transaction, so the
// UI can show measured vs modeled. Stored in SPECK as a string (bigint-safe).
for (const p of presets) {
  const r = rows.find((x) => x.hash === p.source.hash && x.net === p.source.net);
  p.source.feeSpeck = r.fee;
}

const out = {
  generatedAt: new Date().toISOString(),
  dims: DIMS,
  blockLimits: { read_time: 2e12, compute_time: 2e12, block_usage: 1_000_000, bytes_written: 50_000, bytes_churned: 50_000_000 },
  // Per-dimension price factors decoded from stagenet ledgerParameters at block
  // 305,299 on 2026-09-03. They drift a little block to block; the model treats
  // them as a snapshot.
  feeFactors: { read: 0.5710097498159541, compute: 0.5710097498159541, block: 0.5739415011042756, write: 2.2840389992638164 },
  counts: {
    mainnet: rows.filter((r) => r.net === 'mainnet').length,
    preview: rows.filter((r) => r.net === 'preview').length,
    stagenet: rows.filter((r) => r.net === 'stagenet').length,
  },
  presets,
};
writeFileSync(join(here, '..', 'src', 'presets.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote src/presets.json: ${presets.length} presets from ${rows.length} transactions`);
for (const p of presets) console.log(`  ${p.id.padEnd(22)} ${p.source.net.padEnd(8)} h=${p.source.height} ${p.source.bytes} B written=${p.source.bytesWritten}`);
