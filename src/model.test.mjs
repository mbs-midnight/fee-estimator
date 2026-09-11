import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  feeDust, priceMultiplier, blocksToMultiply, budget,
  DUST_PER_NIGHT_PER_DAY, DUST_CAP_PER_NIGHT, TIME_TO_CAP_S, SPECKS_PER_DUST,
} from './model.js';

const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));

test('DUST constants match the ledger', () => {
  assert.equal(DUST_CAP_PER_NIGHT, 5);
  assert.ok(Math.abs(DUST_PER_NIGHT_PER_DAY - 0.7142688) < 1e-6);
  assert.ok(Math.abs(TIME_TO_CAP_S / 86400 - 7.0) < 0.001);
});

test('fee model reproduces every preset’s charged fee within 2.5%', () => {
  for (const p of presets.presets) {
    const modeled = feeDust(p.frac, 10, presets.feeFactors);
    const charged = Number(p.source.feeSpeck) / SPECKS_PER_DUST;
    // Mainnet transactions were charged at the ledger-8 floor (1 SPECK), so only
    // stagenet sources can be compared.
    if (p.source.net !== 'stagenet') continue;
    const err = Math.abs(modeled / charged - 1);
    assert.ok(err < 0.025, `${p.id}: modeled ${modeled} vs charged ${charged} (${(err * 100).toFixed(2)}%)`);
  }
});

test('price controller is neutral at 50% and bounded at the clamps', () => {
  assert.equal(priceMultiplier(0.5), 1);
  assert.ok(Math.abs(priceMultiplier(0.99) - 1.045951) < 1e-5);
  assert.ok(Math.abs(priceMultiplier(0.01) - 0.954049) < 1e-5);
  assert.ok(Math.abs(blocksToMultiply(2, 0.75) - 63.4) < 0.5);
});

test('budget: 1,000 light calls a day at the ledger-9 floor', () => {
  const call = presets.presets.find((p) => p.id === 'call_light');
  const b = budget({
    rows: [{ frac: call.frac, txPerDay: 1000 }], price: 10, factors: presets.feeFactors,
    bufferPct: 0, nightUsd: 0.02, peakTxPerHour: 100, peakHours: 1, inflightSeconds: 30,
  });
  assert.ok(Math.abs(b.avgFee - 0.2003) < 0.001);
  assert.ok(Math.abs(b.dailyBurn - 200.3) < 1);
  assert.ok(Math.abs(b.nightEquilibrium - 200.3 / DUST_PER_NIGHT_PER_DAY) < 1);
  assert.equal(b.walletsNeeded, 1);
});

test('concurrency: wallets = ceil(in-flight / UTXOs per wallet)', () => {
  const call = presets.presets.find((p) => p.id === 'call_light');
  const base = { rows: [{ frac: call.frac, txPerDay: 10000 }], price: 10, factors: presets.feeFactors,
    bufferPct: 0, nightUsd: 0.02, peakTxPerHour: 3600, peakHours: 1, inflightSeconds: 30 };
  const one = budget({ ...base, utxosPerWallet: 1 });
  const ten = budget({ ...base, utxosPerWallet: 10 });
  assert.equal(one.concurrent, 30);
  assert.equal(one.walletsNeeded, 30);
  assert.equal(ten.walletsNeeded, 3);
  assert.equal(ten.totalUtxos, 30);
  assert.ok(Math.abs(ten.nightPerUtxo - one.nightPerWallet) < 1e-9);
});
