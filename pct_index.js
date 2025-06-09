/**
 * pct_index.js  (ema_breadth_full.js)
 * -----------------------------------
 * Computes daily % above EMA-75 & EMA-200 for all USDT spot pairs.
 * Outputs “ema_breadth_pct.csv” and “ema_values.csv”.
 */

// ── 1) Kill any HTTP_PROXY env so Node’s http module is direct ──
process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy  = '';
process.env.https_proxy = '';
process.env.NO_PROXY    = 'localhost,127.0.0.1';

// ── 2) Imports ─────────────────────────────────────────────────
const http   = require('http');
const { URLSearchParams } = require('url');
// const pLimit = require('p-limit').default;
const dayjs  = require('dayjs');
const { EMA } = require('technicalindicators');
const { createObjectCsvWriter } = require('csv-writer');

// ── 3) Config ──────────────────────────────────────────────────
const HOST        = 'localhost';
const PORT        = 8090;
const INTERVAL    = '1d';
const START_DATE  = '2023-06-01';   // ≥200d before 2024-01-01
const QUOTE       = 'USDT';
const CONCURRENCY = 4;
const LIMIT_ROWS  = 1000;           // must be ≥ days since START_DATE (~400)

// ── 4) HTTP GET JSON helper via Node’s built-in http ───────────
function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: HOST, port: PORT, path, method: 'GET' };
    const req  = http.request(opts, res => {
      let buf = '';
      res.on('data', ch => buf += ch);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); }
          catch(err) { reject(err); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} → ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 5) Fetch exactly one batch of up to LIMIT_ROWS bars ────────
async function fetchKlines(symbol) {
  // we never send startTime/endTime—so the proxy will serve from its WS cache
  const qs = new URLSearchParams({
    symbol,
    interval: INTERVAL,
    limit:    String(LIMIT_ROWS),
  }).toString();
  const data = await httpGetJson(`/api/v3/klines?${qs}`);

  // map & filter out anything before START_DATE
  const cutoff = Date.parse(`${START_DATE}T00:00:00Z`);
  return data
    .map(k => ({ time: k[0], close: +k[4] }))
    .filter(bar => bar.time >= cutoff);
}

// pad an EMA array so it aligns with the closes
const padEMA = (arr, period) => Array(period - 1).fill(null).concat(arr);

// ── 6) Main ─────────────────────────────────────────────────────
;(async () => {
  console.time('TOTAL');

  const { default: pLimit } = await import('p-limit');

  // A) Load symbols via exchangeInfo
  const ex     = await httpGetJson('/api/v3/exchangeInfo');
  const symbols= ex.symbols
    .filter(s => s.status==='TRADING'
              && s.isSpotTradingAllowed
              && s.quoteAsset===QUOTE)
    .map(s => s.symbol);
  console.log(`📜  Found ${symbols.length} ${QUOTE} spot pairs`);

  // B) Prepare containers
  const breadth = {};  // { date: { a75,t75,a200,t200 } }
  const rowsSym = [];  
  const limit   = pLimit(CONCURRENCY);

  // C) Fetch + compute each symbol
  await Promise.all(symbols.map(sym =>
    limit(async () => {
      try {
        const kl = await fetchKlines(sym);
        if (kl.length < 200) return;  // need ≥200 bars for EMA-200

        const closes = kl.map(x => x.close);
        const dates  = kl.map(x => dayjs(x.time).format('YYYY-MM-DD'));

        const ema75  = padEMA(EMA.calculate({ period:75,  values:closes }), 75);
        const ema200 = padEMA(EMA.calculate({ period:200, values:closes }), 200);

        for (let i = 0; i < closes.length; i++) {
          const d = dates[i];
          breadth[d] = breadth[d] || { a75:0,t75:0,a200:0,t200:0 };

          const above75  = ema75[i]  !== null && closes[i] > ema75[i];
          const above200 = ema200[i] !== null && closes[i] > ema200[i];

          if (ema75[i]  !== null) { breadth[d].t75++;  if (above75)  breadth[d].a75++;  }
          if (ema200[i] !== null) { breadth[d].t200++; if (above200) breadth[d].a200++; }

          rowsSym.push({
            symbol:   sym,
            date:     d,
            close:    closes[i],
            ema75:    ema75[i],
            ema200:   ema200[i],
            above75,
            above200,
            signal:   (above75 && above200) ? 1 : 0
          });
        }
      } catch (err) {
        console.error(`⚠️  ${sym} → ${err.message}`);
      }
    })
  ));

  // D) Write daily breadth % CSV
  const daily = Object.keys(breadth).sort().map(d => {
    const b = breadth[d];
    return {
      date:          d,
      pct_above_75:  (b.a75  / b.t75  * 100).toFixed(2),
      pct_above_200: (b.a200 / b.t200 * 100).toFixed(2)
    };
  });
  await createObjectCsvWriter({
    path:   'ema_breadth_pct.csv',
    header: [
      { id:'date',         title:'date' },
      { id:'pct_above_75', title:'pct_above_75' },
      { id:'pct_above_200',title:'pct_above_200' }
    ]
  }).writeRecords(daily);
  console.log(`💾  ema_breadth_pct.csv   (${daily.length} rows)`);

  // E) Write per-symbol values CSV
  await createObjectCsvWriter({
    path:   'ema_values.csv',
    header: [
      { id:'symbol',   title:'symbol' },
      { id:'date',     title:'date' },
      { id:'close',    title:'close' },
      { id:'ema75',    title:'ema75' },
      { id:'ema200',   title:'ema200' },
      { id:'above75',  title:'above75' },
      { id:'above200', title:'above200' },
      { id:'signal',   title:'signal' }
    ]
  }).writeRecords(rowsSym);
  console.log(`💾  ema_values.csv        (${rowsSym.length} rows)`);

  console.timeEnd('TOTAL');
})().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
