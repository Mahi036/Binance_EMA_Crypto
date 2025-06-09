/**
 * final_index.js   –  Five-year EMA-breadth + per-symbol EMA dump
 * ---------------------------------------------------------------
 * Output:
 *   • ema_breadth.csv   (daily breadth %)
 *   • ema_values.csv    (symbol-date close, EMA-100, EMA-200, signal)
 */

// ── 1) Kill any HTTP_PROXY env so axios goes direct ────────────
process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy  = '';
process.env.https_proxy = '';
process.env.NO_PROXY    = 'localhost,127.0.0.1';

const axios         = require('axios');
axios.defaults.proxy = false;                   // disable axios proxy
// const pLimit        = require('p-limit').default;
const dayjs         = require('dayjs');
const { EMA }       = require('technicalindicators');
const { createObjectCsvWriter } = require('csv-writer');

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------
const BASE_URL = 'http://127.0.0.1:8090';
console.log("→ Using BASE_URL =", BASE_URL);

const QUOTE_FILTER  = 'USDT';
const INTERVAL      = '1d';
const START_DATE    = '2019-06-01';   // five years before today, adjust as needed
const START_MS      = Date.parse(`${START_DATE}T00:00:00Z`);
const CONCURRENCY   = 3;              // bump if you have extra headroom
const LIMIT_PER_CALL= 1000;           // the proxy cache serves up to 1000

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Fetch up to LIMIT_PER_CALL daily klines for a symbol, via your local proxy.
 * No startTime/endTime params → the proxy will serve from its websocket cache.
 * Then filter out any bars before START_DATE.
 *
 * Returns raw array of [openTime, open, high, low, close, ...] elements.
 */
async function fetchKlines(symbol) {
  const resp = await axios.get(`${BASE_URL}/api/v3/klines`, {
    params: { symbol, interval: INTERVAL, limit: LIMIT_PER_CALL }
  });
  // proxy will return up to 1000 of the most recent bars:
  return resp.data.filter(bar => bar[0] >= START_MS);
}

/**
 * Left-pad an EMA series so it aligns with the full closes length.
 */
function padEMA(arr, period, fullLen) {
  const pad = Array(period - 1).fill(null);
  return pad.concat(arr);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
;(async () => {
  console.time('TOTAL');

  const { default: pLimit } = await import('p-limit');

  // 1) Build your universe of symbols
  const exInfoResp = await axios.get(`${BASE_URL}/api/v3/exchangeInfo`);
  if (!Array.isArray(data)) {
    console.warn(`⚠️  ${symbol}: unexpected proxy response, skipping`, data);
    return [];  // or however you bail in this function
  }
  const symbols = exInfoResp.data.symbols
    .filter(s => s.status === 'TRADING'
              && s.isSpotTradingAllowed
              && s.quoteAsset === QUOTE_FILTER)
    .map(s => s.symbol);

  console.log(`📜  ${symbols.length} ${QUOTE_FILTER}-quoted spot pairs`);

  // 2) Prepare data containers
  const breadth      = {};   // { date: { pos: #, neg: # } }
  const perSymbolRows= [];   // for ema_values.csv
  const limiter      = pLimit(CONCURRENCY);

  // 3) Fetch & compute for each symbol in parallel
  await Promise.all(symbols.map(sym =>
    limiter(async () => {
      try {
        const kl = await fetchKlines(sym);
        if (kl.length < 200) return;  // need 200 for EMA-200

        // extract closes & dates
        const closes = kl.map(k => +k[4]);
        const dates  = kl.map(k => dayjs(k[0]).format('YYYY-MM-DD'));

        // compute EMAs
        const ema100Short = EMA.calculate({ period: 100,  values: closes });
        const ema200Short = EMA.calculate({ period: 200, values: closes });
        const ema100      = padEMA(ema100Short, 100, closes.length);
        const ema200      = padEMA(ema200Short, 200, closes.length);

        // iterate bars
        for (let i = 0; i < closes.length; i++) {
          const date = dates[i];
          const close= closes[i];
          const e100 = ema100[i];
          const e200 = ema200[i];
          const signal = (e100 !== null && e200 !== null && close > e100 && close > e200) ? 1 : 0;

          // record per-symbol row
          perSymbolRows.push({
            symbol: sym,
            date,
            close,
            ema100: e100,
            ema200: e200,
            signal
          });

          // update breadth only once both EMAs exist
          if (e200 !== null) {
            breadth[date] = breadth[date] || { pos: 0, neg: 0 };
            if (close > e100 && close > e200) breadth[date].pos++;
            else breadth[date].neg++;
          }
        }
      } catch (err) {
        console.error(`⚠️  ${sym} → ${err.message}`);
      }
    })
  ));

  // 4) Write breadth % CSV
  const dates = Object.keys(breadth).sort();
  const breadthRecords = dates.map(d => {
    const { pos, neg } = breadth[d];
    const total = pos + neg;
    return {
      date:   d,
      positive: pos,
      negative: neg,
      pos_pct:  (pos  / total * 100).toFixed(2),
      neg_pct:  (neg  / total * 100).toFixed(2),
    };
  });

  await createObjectCsvWriter({
    path: 'ema_breadth.csv',
    header: [
      { id:'date',      title:'date' },
      { id:'positive',  title:'positive' },
      { id:'negative',  title:'negative' },
      { id:'pos_pct',   title:'pos_pct' },
      { id:'neg_pct',   title:'neg_pct' }
    ]
  }).writeRecords(breadthRecords);
  console.log(`💾  Saved breadth → ema_breadth.csv  (${breadthRecords.length} rows)`);

  // 5) Write per-symbol CSV
  await createObjectCsvWriter({
    path: 'ema_values.csv',
    header: [
      { id:'symbol', title:'symbol' },
      { id:'date',   title:'date' },
      { id:'close',  title:'close' },
      { id:'ema100', title:'ema100' },
      { id:'ema200', title:'ema200' },
      { id:'signal', title:'signal' },
    ]
  }).writeRecords(perSymbolRows);
  console.log(`💾  Saved per-symbol → ema_values.csv  (${perSymbolRows.length} rows)`);

  console.timeEnd('TOTAL');
})().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
