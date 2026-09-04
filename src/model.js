// model.js -- the arithmetic behind the estimator. Pure functions, no React.
//
// Sources (all read from midnightntwrk/midnight-ledger, not from documentation):
//   fee      base-crypto/src/cost_model.rs  FeePrices::overall_cost
//   dust     ledger/src/dust.rs             INITIAL_DUST_PARAMETERS, generation math
//   pricing  base-crypto/src/cost_model.rs  price_adjustment_function (1 + logit(u)/a)

// ---- protocol constants -------------------------------------------------------
export const SPECKS_PER_DUST = 1e15;
export const STARS_PER_NIGHT = 1e6;
export const NIGHT_DUST_RATIO = 5e9;        // SPECK of capacity per STAR  -> 5 DUST per NIGHT
export const GENERATION_DECAY_RATE = 8267;  // SPECK per STAR per second
export const BLOCK_TIME_S = 6;
export const PRICE_ADJUSTMENT_A = 100;
export const FLOOR_PRICE_LEDGER9 = 10;      // min_block_price in ledger-9 parameters (stagenet)
export const FLOOR_PRICE_LEDGER8 = 5.421010862427522e-18; // MIN_COST, where mainnet and preview sit today

export const DUST_CAP_PER_NIGHT = NIGHT_DUST_RATIO * STARS_PER_NIGHT / SPECKS_PER_DUST; // 5
export const DUST_PER_NIGHT_PER_DAY = GENERATION_DECAY_RATE * STARS_PER_NIGHT * 86400 / SPECKS_PER_DUST; // 0.7142688
export const TIME_TO_CAP_S = NIGHT_DUST_RATIO / GENERATION_DECAY_RATE; // 604,814 s ~= 7.0 days
export const BLOCKS_PER_DAY = 86400 / BLOCK_TIME_S;

// ---- fee -------------------------------------------------------------------------
// fee_DUST = price * ( max(f_read*r, f_compute*c, f_block*b) + f_write*(w + churn) )
// where r,c,b,w,churn are the transaction's costs as fractions of the block limits.
export function feeDust(frac, price, factors) {
  const util = Math.max(
    factors.read * frac.read_time,
    factors.compute * frac.compute_time,
    factors.block * frac.block_usage,
  );
  const writes = factors.write * (frac.bytes_written + frac.bytes_churned);
  return price * (util + writes);
}

// Which term of the fee formula dominates, for explanation in the UI.
export function feeAnatomy(frac, price, factors) {
  const terms = {
    read_time: factors.read * frac.read_time,
    compute_time: factors.compute * frac.compute_time,
    block_usage: factors.block * frac.block_usage,
  };
  const utilDim = Object.keys(terms).reduce((a, b) => (terms[a] >= terms[b] ? a : b));
  const util = terms[utilDim];
  const write = factors.write * frac.bytes_written;
  const churn = factors.write * frac.bytes_churned;
  const total = util + write + churn;
  return {
    utilDim,
    utilShare: util / total,
    writeShare: write / total,
    churnShare: churn / total,
    utilDust: price * util,
    writeDust: price * write,
    churnDust: price * churn,
    totalDust: price * total,
  };
}

// ---- price dynamics --------------------------------------------------------------
// Per-block multiplier applied to overall_price after a block of fullness u.
export function priceMultiplier(fullness) {
  const u = Math.min(Math.max(fullness, 0.01), 0.99);
  return 1 + Math.log(u / (1 - u)) / PRICE_ADJUSTMENT_A;
}
export function blocksToMultiply(factor, fullness) {
  const m = priceMultiplier(fullness);
  if (m === 1 || factor <= 0) return Infinity;
  return Math.log(factor) / Math.log(m);
}

// ---- budget -----------------------------------------------------------------------
// rows: [{ frac, txPerDay }]
export function budget({ rows, price, factors, bufferPct, nightUsd, peakTxPerHour, peakHours, inflightSeconds }) {
  const priced = rows.map((r) => {
    const fee = feeDust(r.frac, price, factors);
    return { ...r, fee, dailyDust: fee * r.txPerDay };
  });
  const txPerDay = priced.reduce((a, r) => a + r.txPerDay, 0);
  const dailyBurn = priced.reduce((a, r) => a + r.dailyDust, 0);
  const avgFee = txPerDay > 0 ? dailyBurn / txPerDay : 0;

  // Infinite runway: generation must match burn. Generation is linear in NIGHT
  // held, at DUST_PER_NIGHT_PER_DAY, as long as the reservoir is below cap.
  const nightEquilibrium = dailyBurn / DUST_PER_NIGHT_PER_DAY;
  const nightRecommended = nightEquilibrium * (1 + bufferPct / 100);
  const reservoirDust = nightRecommended * DUST_CAP_PER_NIGHT;
  const dailyGeneration = nightRecommended * DUST_PER_NIGHT_PER_DAY;

  // Burst: a full reservoir can absorb spending above the generation rate.
  const peakBurnPerHour = peakTxPerHour * avgFee;
  const generationPerHour = dailyGeneration / 24;
  const netDrainPerHour = Math.max(peakBurnPerHour - generationPerHour, 0);
  const burstHoursCovered = netDrainPerHour > 0 ? reservoirDust / netDrainPerHour : Infinity;
  const peakDrain = netDrainPerHour * peakHours;
  const nightForPeak = peakDrain > 0 ? peakDrain / DUST_CAP_PER_NIGHT : 0; // extra NIGHT so the reservoir covers the peak
  const refillHours = peakDrain > 0 && dailyGeneration > 0 ? peakDrain / (dailyGeneration - dailyBurn) * 24 : 0;

  // Concurrency: with the current wallet SDK a wallet has exactly one transaction
  // in flight (building a transaction moves all of its DUST to pending), so the
  // number of concurrent in-flight transactions is the number of wallets.
  const peakTxPerSecond = peakTxPerHour / 3600;
  const walletsNeeded = Math.max(1, Math.ceil(peakTxPerSecond * inflightSeconds));
  const nightPerWallet = walletsNeeded > 0 ? nightRecommended / walletsNeeded : 0;

  return {
    priced, txPerDay, dailyBurn, avgFee,
    nightEquilibrium, nightRecommended, reservoirDust, dailyGeneration,
    surplusPerDay: dailyGeneration - dailyBurn,
    runwayDaysNoGeneration: dailyBurn > 0 ? reservoirDust / dailyBurn : Infinity,
    peakBurnPerHour, generationPerHour, netDrainPerHour, burstHoursCovered, nightForPeak, refillHours,
    walletsNeeded, nightPerWallet,
    usdRecommended: nightRecommended * nightUsd,
    usdForPeak: nightForPeak * nightUsd,
  };
}
