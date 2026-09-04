import { useMemo, useState } from 'react';
import presetsData from './presets.json';
import {
  budget, feeDust, feeAnatomy, priceMultiplier, blocksToMultiply,
  DUST_CAP_PER_NIGHT, DUST_PER_NIGHT_PER_DAY, TIME_TO_CAP_S, FLOOR_PRICE_LEDGER9,
  FLOOR_PRICE_LEDGER8, SPECKS_PER_DUST, BLOCK_TIME_S,
} from './model.js';

const PRESETS = presetsData.presets;
const FACTORS = presetsData.feeFactors;
const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

const PRICE_SCENARIOS = [
  { id: 'floor', label: 'Floor (10)', mult: 1, desc: 'The ledger-9 minimum block price. Where stagenet sits today and where the price rests whenever blocks stay under 50% full.' },
  { id: 'x2', label: '2×', mult: 2, desc: 'Sustained blocks above half full push the price up geometrically. 2× takes about 6 minutes at 75% fullness.' },
  { id: 'x5', label: '5×', mult: 5, desc: 'About 15 minutes at 75% fullness, or 35 minutes at 60%.' },
  { id: 'x10', label: '10×', mult: 10, desc: 'About 21 minutes at 75% fullness. The price has no ceiling; it falls back at the same rate once blocks drop under 50%.' },
];

const fmt = (n, d = 2) => {
  if (!Number.isFinite(n)) return '∞';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 0.001) return n.toExponential(2);
  if (a < 0.01) return n.toFixed(4);
  if (a < 1) return n.toFixed(3);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
};
const fInt = (n) => (Number.isFinite(n) ? Math.ceil(n).toLocaleString('en-US') : '∞');
const fHours = (h) => {
  if (!Number.isFinite(h)) return 'indefinitely';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};

function Field({ label, help, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
    </div>
  );
}
function Num({ value, onChange, min = 0, step = 1, max }) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
  );
}
function Stat({ k, v, s, tone }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={'v' + (tone ? ' ' + tone : '')}>{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

export default function App() {
  const [rows, setRows] = useState([
    { key: 1, presetId: 'call_typical', txPerDay: 1000 },
    { key: 2, presetId: 'transfer_guaranteed', txPerDay: 200 },
  ]);
  const [scenario, setScenario] = useState('floor');
  const [customMult, setCustomMult] = useState(1);
  const [fullness, setFullness] = useState(75);
  const [fullMinutes, setFullMinutes] = useState(20);
  const [bufferPct, setBufferPct] = useState(25);
  const [nightUsd, setNightUsd] = useState(0.02);
  const [peakTxPerHour, setPeakTxPerHour] = useState(300);
  const [peakHours, setPeakHours] = useState(2);
  const [inflightSeconds, setInflightSeconds] = useState(30);
  const [anatomyId, setAnatomyId] = useState('call_typical');

  const fullnessBlocks = Math.max(fullMinutes, 0) * 60 / BLOCK_TIME_S;
  const fullnessMult = Math.max(Math.pow(priceMultiplier(fullness / 100), fullnessBlocks), 1); // the floor holds below 50%
  const mult = scenario === 'custom' ? Math.max(customMult, 0)
    : scenario === 'fullness' ? fullnessMult
    : PRICE_SCENARIOS.find((s) => s.id === scenario).mult;
  const recoveryMinutes = fullnessMult > 1 ? blocksToMultiply(1 / fullnessMult, 1 - fullness / 100) * BLOCK_TIME_S / 60 : 0;
  const price = FLOOR_PRICE_LEDGER9 * mult;

  const result = useMemo(() => budget({
    rows: rows.map((r) => ({ ...r, frac: byId[r.presetId].frac, recipients: byId[r.presetId].recipients })),
    price, factors: FACTORS, bufferPct, nightUsd, peakTxPerHour, peakHours, inflightSeconds,
  }), [rows, price, bufferPct, nightUsd, peakTxPerHour, peakHours, inflightSeconds]);

  const anatomyPreset = byId[anatomyId];
  const anatomy = feeAnatomy(anatomyPreset.frac, price, FACTORS);
  const deficit = result.surplusPerDay < 0;

  const update = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key) => setRows((rs) => rs.filter((r) => r.key !== key));
  const add = () => setRows((rs) => [...rs, { key: Date.now(), presetId: 'call_light', txPerDay: 100 }]);

  return (
    <div className="wrap">
      <header>
        <div className="eyebrow">Midnight &middot; DUST sponsorship planning</div>
        <h1>NIGHT Estimator</h1>
        <p className="lede">
          How much NIGHT must a DApp hold to pay its users&rsquo; DUST fees indefinitely? Every fee here is computed
          with the ledger&rsquo;s own formula from the measured cost of a real transaction, not a rule of thumb.
        </p>
      </header>

      <div className="grid">
        <div>
          <section className="panel">
            <h2>Transaction mix</h2>
            <div className="scroll">
              <table className="mix">
                <thead><tr><th>Shape</th><th className="num">Per day</th><th className="num">Fee / tx</th><th className="num">DUST / day</th><th /></tr></thead>
                <tbody>
                  {result.priced.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <select value={r.presetId} onChange={(e) => update(r.key, { presetId: e.target.value })}>
                          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                      </td>
                      <td className="num"><Num value={r.txPerDay} onChange={(v) => update(r.key, { txPerDay: v })} step={10} /></td>
                      <td className="num">{fmt(r.fee, 3)}</td>
                      <td className="num">{fmt(r.dailyDust)}</td>
                      <td>{rows.length > 1 && <button className="rm" onClick={() => remove(r.key)} aria-label="remove row">&times;</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="add" onClick={add}>+ add a shape</button>
            <p className="muted" style={{ marginTop: 10 }}>{byId[rows[rows.length - 1].presetId].note}</p>
          </section>

          <section className="panel">
            <h2>Price scenario</h2>
            <div className="pills" role="group">
              {PRICE_SCENARIOS.map((s) => (
                <button key={s.id} className="pill" aria-pressed={scenario === s.id} onClick={() => setScenario(s.id)}>{s.label}</button>
              ))}
              <button className="pill" aria-pressed={scenario === 'fullness'} onClick={() => setScenario('fullness')}>fullness + duration</button>
              <button className="pill" aria-pressed={scenario === 'custom'} onClick={() => setScenario('custom')}>custom</button>
            </div>
            {scenario === 'fullness' ? (
              <div style={{ marginTop: 10 }}>
                <div className="two">
                  <Field label="Sustained block fullness (%)" help="Below 50% the price only decays, so the floor holds and the multiple is 1.">
                    <Num value={fullness} onChange={setFullness} min={1} max={99} step={1} />
                  </Field>
                  <Field label="For how long (minutes)" help={`${Math.round(fullnessBlocks)} blocks at ${BLOCK_TIME_S} s.`}>
                    <Num value={fullMinutes} onChange={setFullMinutes} step={5} />
                  </Field>
                </div>
                <p className="muted">
                  Each block multiplies the price by {priceMultiplier(fullness / 100).toFixed(5)}
                  {fullness > 50 ? (
                    <> &rarr; after {Math.round(fullnessBlocks)} blocks the price is <b>{fmt(fullnessMult, 2)}&times;</b> the floor.
                    Once blocks fall back to {100 - fullness}% full it takes about {fmt(recoveryMinutes, 0)} minutes to return to the floor.</>
                  ) : fullness === 50 ? (
                    <> &mdash; exactly neutral. 50% is the controller&rsquo;s target, so the price does not move.</>
                  ) : (
                    <> &mdash; below 1, so the price decays. It is already at the floor and cannot go lower.</>
                  )}
                </p>
              </div>
            ) : scenario === 'custom' ? (
              <div style={{ maxWidth: 200, marginTop: 10 }}>
                <Field label="Multiple of the floor price"><Num value={customMult} onChange={setCustomMult} step={0.5} min={0} /></Field>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: 8 }}>{PRICE_SCENARIOS.find((s) => s.id === scenario).desc}</p>
            )}
            <p className="small" style={{ marginTop: 6 }}>
              <code>overall_price</code> = {fmt(price, 2)}. Fees scale linearly with it.
            </p>
          </section>

          <section className="panel">
            <h2>Peak load &amp; buffer</h2>
            <div className="two">
              <Field label="Safety buffer (%)" help="Extra NIGHT above the exact equilibrium."><Num value={bufferPct} onChange={setBufferPct} step={5} /></Field>
              <Field label="NIGHT price (USD)" help="Only used for the dollar figures."><Num value={nightUsd} onChange={setNightUsd} step={0.01} /></Field>
              <Field label="Peak transactions per hour" help="The busiest hour you expect to sponsor."><Num value={peakTxPerHour} onChange={setPeakTxPerHour} step={50} /></Field>
              <Field label="Peak lasts (hours)"><Num value={peakHours} onChange={setPeakHours} step={0.5} /></Field>
              <Field label="Seconds per transaction in flight" help="Prove + submit + confirm. Unshielded transfers prove in 1–5 s on stagenet; contract calls take longer; a 70 KB shielded transfer took 84 s."><Num value={inflightSeconds} onChange={setInflightSeconds} step={5} /></Field>
            </div>
          </section>

          <section className="panel">
            <h2>Where the fee comes from</h2>
            <Field label="Shape">
              <select value={anatomyId} onChange={(e) => setAnatomyId(e.target.value)}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <p className="small">
              {anatomyPreset.note} Source: {anatomyPreset.source.net} block {anatomyPreset.source.height.toLocaleString('en-US')},{' '}
              {anatomyPreset.source.bytes.toLocaleString('en-US')} B, {anatomyPreset.source.bytesWritten.toLocaleString('en-US')} B written.
            </p>
            <div className="anatomy">
              {presetsData.dims.map((d) => {
                const share = anatomyPreset.frac[d];
                const isUtil = d === anatomy.utilDim;
                const isMaxed = ['read_time', 'compute_time', 'block_usage'].includes(d) && !isUtil;
                return (
                  <div className="bar-row" key={d}>
                    <div className="n">{d}</div>
                    <div className="track"><div className={'fill' + (isMaxed ? ' dim' : '')} style={{ width: `${Math.min(share * 100 * 4, 100)}%` }} /></div>
                    <div className="val">{(share * 100).toFixed(3)}%</div>
                  </div>
                );
              })}
              <p className="muted" style={{ marginTop: 8 }}>
                Bars are the share of each block limit, drawn at 4&times; scale. Of the three time and size dimensions only the largest
                (<code>{anatomy.utilDim}</code>) is charged; the other two are shown faded. Writes and churn are always added.
              </p>
            </div>
            <table className="plain">
              <tbody>
                <tr><td>max(read, compute, size) &middot; <code>{anatomy.utilDim}</code></td><td className="num">{fmt(anatomy.utilDust, 4)} DUST</td><td className="num">{(anatomy.utilShare * 100).toFixed(0)}%</td></tr>
                <tr><td>state written</td><td className="num">{fmt(anatomy.writeDust, 4)} DUST</td><td className="num">{(anatomy.writeShare * 100).toFixed(0)}%</td></tr>
                <tr><td>storage churn</td><td className="num">{fmt(anatomy.churnDust, 4)} DUST</td><td className="num">{(anatomy.churnShare * 100).toFixed(0)}%</td></tr>
                <tr><td><b>fee at this price</b></td><td className="num"><b>{fmt(anatomy.totalDust, 4)} DUST</b></td><td className="num">
                  {anatomyPreset.source.net === 'stagenet' && mult === 1 && (
                    <span className="muted">charged {fmt(Number(anatomyPreset.source.feeSpeck) / SPECKS_PER_DUST, 4)}</span>
                  )}
                </td></tr>
              </tbody>
            </table>
          </section>
        </div>

        <div className="sticky">
          <div className={'hero' + (deficit ? ' deficit' : '')}>
            <div className="label">Hold this much NIGHT</div>
            <div className="big">{fInt(result.nightRecommended)}<small>NIGHT</small></div>
            <div className="sub">
              Generates {fmt(result.dailyGeneration)} DUST/day against a burn of {fmt(result.dailyBurn)} DUST/day
              &mdash; {result.surplusPerDay >= 0 ? 'a surplus of ' : 'a deficit of '}{fmt(Math.abs(result.surplusPerDay))} DUST/day.
              Exact equilibrium is {fInt(result.nightEquilibrium)} NIGHT; the rest is your {bufferPct}% buffer.
            </div>
            <div className="stats">
              <Stat k="At $" v={nightUsd > 0 ? `$${fmt(result.usdRecommended)}` : '—'} s={`at $${nightUsd} per NIGHT`} />
              <Stat k="Average fee" v={`${fmt(result.avgFee, 3)} DUST`} s={`${fInt(result.txPerDay)} tx/day`} />
              <Stat k="DUST reservoir when full" v={`${fmt(result.reservoirDust)} DUST`} s={`${DUST_CAP_PER_NIGHT} DUST per NIGHT, fills in ${(TIME_TO_CAP_S / 86400).toFixed(1)} days`} />
              <Stat k="Runway if generation stopped" v={fHours(result.runwayDaysNoGeneration * 24)} s="spending the reservoir alone" />
            </div>
          </div>

          <section className="panel" style={{ marginTop: 18 }}>
            <h2>Peak hour</h2>
            <div className="stats" style={{ marginTop: 0 }}>
              <Stat k="Peak burn" v={`${fmt(result.peakBurnPerHour)} DUST/h`} s={`vs ${fmt(result.generationPerHour)} DUST/h generated`} />
              <Stat k="Reservoir covers the peak for" v={fHours(result.burstHoursCovered)} tone={result.burstHoursCovered < peakHours ? 'warn' : 'ok'}
                s={result.burstHoursCovered < peakHours ? `shorter than the ${peakHours} h peak` : 'longer than the peak'} />
              <Stat k="Extra NIGHT so the reservoir covers it" v={result.nightForPeak > result.nightRecommended ? fInt(result.nightForPeak - result.nightRecommended) : '0'}
                s={result.nightForPeak > 0 ? `${fInt(result.nightForPeak)} NIGHT of reservoir needed for the peak` : 'generation alone keeps up'} />
              <Stat k="Refill after the peak" v={result.refillHours > 0 ? fHours(result.refillHours) : '—'} s="from your daily surplus" />
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              A full reservoir holds {DUST_CAP_PER_NIGHT} DUST per NIGHT and generates {DUST_PER_NIGHT_PER_DAY.toFixed(3)} DUST per NIGHT per day.
              DUST stops accruing at the cap, so a sponsor that spends less than it generates is always full and can absorb a burst.
            </p>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <h2>Wallets</h2>
            <div className="stats" style={{ marginTop: 0 }}>
              <Stat k="Wallets for the peak" v={result.walletsNeeded.toLocaleString('en-US')} s={`${fmt(peakTxPerHour / 3600, 3)} tx/s × ${inflightSeconds} s in flight`} />
              <Stat k="NIGHT per wallet" v={fInt(result.nightPerWallet)} s="split the holding evenly" />
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              With the current wallet SDK, building a transaction moves <em>all</em> of a wallet&rsquo;s DUST to pending, so a wallet has
              exactly one transaction in flight. Concurrency equals wallet count. Each wallet also needs one DUST registration
              ({fmt(feeDust(byId.dust_registration.frac, price, FACTORS), 3)} DUST) before its NIGHT generates anything.
            </p>
          </section>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Mainnet today</h2>
        <p>
          Mainnet and preview run ledger 8, whose price floor is <code>{FLOOR_PRICE_LEDGER8.toExponential(2)}</code>. The price fell to that
          floor within two hours of genesis and has stayed there, so every mainnet transaction costs exactly 1 SPECK
          (10<sup>&minus;15</sup> DUST). Sponsoring fees on mainnet today is free. Stagenet runs ledger 9, which adds a
          <code>min_block_price</code> of 10; everything above is priced at that floor, which is what mainnet will charge after it upgrades.
          The block limits and the per-operation cost model are identical on all three networks, so a transaction that costs
          0.20 DUST on stagenet will cost 0.20 DUST on mainnet at the same price.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>How the price moves</h2>
        <p>
          After every block the price is multiplied by 1 + logit(fullness)/100. Exactly 1 at 50% full; above that the price
          climbs geometrically, below it the price decays until it hits the floor. There is no ceiling. The buffer and the
          price scenario above are how you plan for this.
        </p>
        <div className="scroll">
          <table className="plain">
            <thead><tr><th>Sustained fullness</th><th className="num">Per-block multiplier</th><th className="num">Price doubles in</th><th className="num">10&times; in</th></tr></thead>
            <tbody>
              {[0.55, 0.6, 0.75, 0.9, 0.99].map((u) => {
                const m = priceMultiplier(u);
                const b2 = blocksToMultiply(2, u), b10 = blocksToMultiply(10, u);
                return (
                  <tr key={u}>
                    <td>{(u * 100).toFixed(0)}%</td>
                    <td className="num">{m.toFixed(5)}</td>
                    <td className="num">{Math.round(b2)} blocks &middot; {fHours(b2 * BLOCK_TIME_S / 3600)}</td>
                    <td className="num">{Math.round(b10)} blocks &middot; {fHours(b10 * BLOCK_TIME_S / 3600)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>The shapes, measured</h2>
        <div className="scroll">
          <table className="plain">
            <thead><tr><th>Shape</th><th>Source</th><th className="num">Bytes</th><th className="num">Written</th><th className="num">Fee at floor</th><th className="num">Charged</th></tr></thead>
            <tbody>
              {PRESETS.map((p) => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td className="muted">{p.source.net} #{p.source.height.toLocaleString('en-US')}</td>
                  <td className="num">{p.source.bytes.toLocaleString('en-US')}</td>
                  <td className="num">{p.source.bytesWritten.toLocaleString('en-US')}</td>
                  <td className="num">{fmt(feeDust(p.frac, FLOOR_PRICE_LEDGER9, FACTORS), 3)} DUST</td>
                  <td className="num muted">{p.source.net === 'stagenet' ? `${fmt(Number(p.source.feeSpeck) / SPECKS_PER_DUST, 3)} DUST` : '1 SPECK (ledger-8 floor)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary>Fee formula and constants</summary>
          <p className="small" style={{ marginTop: 8 }}>
            <code>fee = overall_price &times; ( max(f<sub>read</sub>&middot;read, f<sub>compute</sub>&middot;compute, f<sub>size</sub>&middot;size) + f<sub>write</sub>&middot;(written + churned) )</code>,
            with each cost expressed as a fraction of its block limit (2.000 s, 2.000 s, 1,000,000 B, 50,000 B, 50,000,000 B).
            The per-dimension factors were {FACTORS.read.toFixed(3)} / {FACTORS.compute.toFixed(3)} / {FACTORS.block.toFixed(3)} / {FACTORS.write.toFixed(3)} on
            stagenet when the data was taken; they drift slowly and the model treats them as fixed, which is why modeled and charged
            fees differ by up to about 2%.
          </p>
          <p className="small">
            DUST: 1 NIGHT backs {DUST_CAP_PER_NIGHT} DUST of capacity and generates 8,267 SPECK per STAR per second, which is {DUST_PER_NIGHT_PER_DAY.toFixed(4)} DUST
            per NIGHT per day; an empty reservoir fills in {(TIME_TO_CAP_S / 86400).toFixed(2)} days. Generation stops at the cap and
            resumes as soon as DUST is spent, so <em>NIGHT held &times; {DUST_PER_NIGHT_PER_DAY.toFixed(3)} = the most DUST you can burn per day forever.</em>
          </p>
        </details>
      </section>

      <footer>
        Calibrated on {presetsData.counts.mainnet + presetsData.counts.preview + presetsData.counts.stagenet} transactions costed with
        <code>Transaction.cost(params)</code> against live ledger parameters on 3 September 2026: mainnet ({presetsData.counts.mainnet}),
        preview ({presetsData.counts.preview}), stagenet ({presetsData.counts.stagenet}). Regenerate the presets with <code>npm run presets</code>.
        Block time 6.000 s on mainnet and stagenet, 6.018 s on preview. Ledger-level costs only; proving time and mempool ingest are not modeled.
      </footer>
    </div>
  );
}
