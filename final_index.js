/**
 * final_index.js  (ema_breadth_full + per-symbol dump)
 * ----------------------------------------------------
 * Five-year EMA-breadth + per-symbol EMA-50/EMA-200.
 * Outputs “data/ema_breadth.csv” & “data/ema_values.csv”.
 */

process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy  = '';
process.env.https_proxy = '';
process.env.NO_PROXY    = 'localhost,127.0.0.1';

const http   = require('http');
const { URLSearchParams } = require('url');
const dayjs  = require('dayjs');
const { EMA } = require('technicalindicators');
const { createObjectCsvWriter } = require('csv-writer');

const HOST        = '127.0.0.1';
const PORT        = 8090;
const INTERVAL    = '1d';
const START_DATE  = '2019-01-01';  // five years back from 2024
const QUOTE       = 'USDT';
const CONCURRENCY = 3;
const LIMIT_ROWS  = 1000;

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

async function fetchDailyKlines(symbol) {
  const qs = new URLSearchParams({
    symbol,
    interval: INTERVAL,
    limit:    String(LIMIT_ROWS),
  }).toString();
  const data = await httpGetJson(`/api/v3/klines?${qs}`);
  const cutoff = Date.parse(`${START_DATE}T00:00:00Z`);
  return data
    .map(k => ({ time: k[0], close: +k[4] }))
    .filter(bar => bar.time >= cutoff);
}

const padEMA = (arr, period) => Array(period - 1).fill(null).concat(arr);

;(async () => {
  console.time('TOTAL-FINAL');
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(CONCURRENCY);

  const ex = await httpGetJson('/api/v3/exchangeInfo');
  const symbols = ex.symbols
    .filter(s => s.status==='TRADING'
              && s.isSpotTradingAllowed
              && s.quoteAsset===QUOTE)
    .map(s => s.symbol);

  const breadth = {};
  const rowsSym = [];

  await Promise.all(symbols.map(sym =>
    limit(async () => {
      try {
        const kl = await fetchDailyKlines(sym);
        if (kl.length < 200) return;

        const closes = kl.map(x => x.close);
        const dates  = kl.map(x => dayjs(x.time).format('YYYY-MM-DD'));

        const ema50  = padEMA(EMA.calculate({ period: 50, values: closes }), 50);
        const ema200 = padEMA(EMA.calculate({ period:200, values: closes }),200);

        for (let i=0; i<closes.length; i++){
          const d = dates[i];
          breadth[d] = breadth[d] || { pos:0, neg:0 };

          const ok = closes[i]>ema50[i] && closes[i]>ema200[i];
          breadth[d][ ok? 'pos':'neg' ]++;

          rowsSym.push({
            symbol: sym,
            date:   d,
            close:  closes[i],
            ema50:  ema50[i],
            ema200: ema200[i],
            signal: ok? 1:0
          });
        }
      } catch (err) {
        console.error(`⚠️  ${sym} → ${err.message}`);
      }
    })
  ));

  // write breadth
  const days = Object.keys(breadth).sort();
  await createObjectCsvWriter({
    path: 'data/ema_breadth.csv',
    header: [
      { id:'date', title:'date' },
      { id:'positive', title:'positive' },
      { id:'negative', title:'negative' },
      { id:'pos_pct', title:'pos_pct' },
      { id:'neg_pct', title:'neg_pct' }
    ]
  }).writeRecords(
    days.map(d => {
      const { pos, neg } = breadth[d];
      const tot = pos+neg;
      return {
        date: d,
        positive: pos,
        negative: neg,
        pos_pct: (pos/tot*100).toFixed(2),
        neg_pct: (neg/tot*100).toFixed(2)
      };
    })
  );

  console.log(`💾  data/ema_breadth.csv (${days.length} rows)`);

  // write per-symbol
  await createObjectCsvWriter({
    path: 'data/ema_values.csv',
    header: [
      { id:'symbol', title:'symbol' },
      { id:'date',   title:'date' },
      { id:'close',  title:'close' },
      { id:'ema50',  title:'ema50' },
      { id:'ema200', title:'ema200' },
      { id:'signal', title:'signal' }
    ]
  }).writeRecords(rowsSym);

  console.log(`💾  data/ema_values.csv (${rowsSym.length} rows)`);
  console.timeEnd('TOTAL-FINAL');
})();
