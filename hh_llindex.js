/**
 * hh_llindex.js  (hh_ll_net_90days.js)
 * ------------------------------------
 * Computes 90-day higher-high / lower-low net counts for USDT
 * spot pairs; writes “data/hh_ll_net_90days.csv”.
 */

process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.NO_PROXY    = 'localhost,127.0.0.1';

const http   = require('http');
const { URLSearchParams } = require('url');
const dayjs  = require('dayjs');
const { createObjectCsvWriter } = require('csv-writer');

const HOST           = '127.0.0.1';
const PORT           = 8090;
const INTERVAL       = '1d';
const LOOKBACK_DAYS  = 90;
const ANALYSIS_START = '2024-01-01';
const START_DATE     = dayjs(ANALYSIS_START)
                        .subtract(LOOKBACK_DAYS, 'day')
                        .format('YYYY-MM-DD');
const LIMIT_ROWS     = 1000;
const CONCURRENCY    = 4;

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
    limit:    String(LIMIT_ROWS)
  }).toString();
  const data = await httpGetJson(`/api/v3/klines?${qs}`);
  const cutoff = Date.parse(`${START_DATE}T00:00:00Z`);
  return data
    .map(k => ({
      date:  dayjs(k[0]).format('YYYY-MM-DD'),
      close: +k[4]
    }))
    .filter(bar => Date.parse(bar.date) >= cutoff);
}

async function flagHHLLforSymbol(symbol) {
  const candles = await fetchDailyKlines(symbol);
  const hh = {}, ll = {};
  const window90 = [];
  for (const { date, close } of candles) {
    if (window90.length < LOOKBACK_DAYS) {
      hh[date] = false; ll[date] = false;
      window90.push(close);
      continue;
    }
    const max90 = Math.max(...window90);
    const min90 = Math.min(...window90);
    hh[date] = close > max90;
    ll[date] = close < min90;
    window90.shift();
    window90.push(close);
  }
  return { hh_flags: hh, ll_flags: ll };
}

;(async () => {
  console.time('HHLL');

  const ex = await httpGetJson('/api/v3/exchangeInfo');
  const symbols = ex.symbols
    .filter(s => s.status==='TRADING'
              && s.isSpotTradingAllowed
              && s.quoteAsset==='USDT')
    .map(s => s.symbol);

  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(CONCURRENCY);

  const allDates  = new Set();
  const hh_counts = {};
  const ll_counts = {};

  await Promise.all(symbols.map(sym =>
    limit(async () => {
      try {
        const { hh_flags, ll_flags } = await flagHHLLforSymbol(sym);
        for (const d of Object.keys(hh_flags)) {
          allDates.add(d);
          if (d < ANALYSIS_START) continue;
          if (hh_flags[d]) hh_counts[d] = (hh_counts[d]||0) + 1;
          if (ll_flags[d]) ll_counts[d] = (ll_counts[d]||0) + 1;
        }
      } catch (err) {
        console.error(`⚠️  ${sym} → ${err.message}`);
      }
    })
  ));

  const output = Array.from(allDates)
    .filter(d => d >= ANALYSIS_START)
    .sort((a,b)=>new Date(a)-new Date(b))
    .map(d => ({
      date:      d,
      hh_count:  hh_counts[d]||0,
      ll_count:  ll_counts[d]||0,
      net_count: (hh_counts[d]||0) - (ll_counts[d]||0)
    }));

  await createObjectCsvWriter({
    path: 'data/hh_ll_net_90days.csv',
    header: [
      { id:'date',      title:'date' },
      { id:'hh_count',  title:'hh_count' },
      { id:'ll_count',  title:'ll_count' },
      { id:'net_count', title:'net_count' }
    ]
  }).writeRecords(output);
  console.log(`💾  data/hh_ll_net_90days.csv (${output.length} rows)`);

  console.timeEnd('HHLL');
})();
