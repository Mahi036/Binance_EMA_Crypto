/**
 * hh_llindex.js  (hh_ll_net_90days.js)
 *
 * For every USDT-quoted spot token on Binance, this script:
 *  1) Fetches up to LIMIT_ROWS daily closes via local proxy (no startTime)
 *  2) Filters to ≥ START_DATE (90 days before 2024-01-01)
 *  3) Flags 90-day higher-highs / lower-lows
 *  4) Aggregates hh_count, ll_count, net_count
 *  5) Writes hh_ll_net_90days.csv
 */

process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.NO_PROXY    = 'localhost,127.0.0.1';

"use strict";

const http   = require('http');
const { URLSearchParams } = require('url');
// const pLimit = require('p-limit').default;
const dayjs  = require('dayjs');
const { createObjectCsvWriter } = require('csv-writer');

// ─── CONFIG ────────────────────────────────────────────────────
const HOST           = 'localhost';
const PORT           = 8090;
const INTERVAL       = '1d';
const LOOKBACK_DAYS  = 90;
const ANALYSIS_START = '2024-01-01';
const START_DATE     = dayjs(ANALYSIS_START)
                        .subtract(LOOKBACK_DAYS, 'day')
                        .format('YYYY-MM-DD');
const LIMIT_ROWS     = 1000;   // must cover ≥ LOOKBACK_DAYS
const CONCURRENCY    = 4;

// ─── HTTP GET JSON (no proxy) ───────────────────────────────────
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

// ─── Fetch one batch of klines & filter by START_DATE ───────────
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

// ─── Flag HH/LL for one symbol ─────────────────────────────────
async function flagHHLLforSymbol(symbol) {
  const candles = await fetchDailyKlines(symbol);
  const hh_flags = {};
  const ll_flags = {};
  const window90 = [];

  for (const { date, close } of candles) {
    if (window90.length < LOOKBACK_DAYS) {
      hh_flags[date] = false;
      ll_flags[date] = false;
      window90.push(close);
      continue;
    }
    const max90 = Math.max(...window90);
    const min90 = Math.min(...window90);
    hh_flags[date] = close > max90;
    ll_flags[date] = close < min90;
    window90.shift();
    window90.push(close);
  }
  return { hh_flags, ll_flags };
}

// ─── MAIN ───────────────────────────────────────────────────────
(async () => {
  console.log(`Fetching bars since ${START_DATE}, flagging from ${ANALYSIS_START}`);

  const { default: pLimit } = await import('p-limit');

  // 1) load symbols
  const exInfo = await httpGetJson('/api/v3/exchangeInfo');
  const symbols = exInfo.symbols
    .filter(s =>
      s.status === 'TRADING' &&
      s.isSpotTradingAllowed &&
      s.quoteAsset === 'USDT'
    )
    .map(s => s.symbol);
  console.log(`📜  ${symbols.length} USDT spot symbols`);

  // 2) prepare aggregators
  const allDates  = new Set();
  const hh_counts = {};
  const ll_counts = {};
  const limit     = pLimit(CONCURRENCY);

  // 3) process each symbol
  await Promise.all(symbols.map(sym =>
    limit(async () => {
      try {
        const { hh_flags, ll_flags } = await flagHHLLforSymbol(sym);
        for (const date of Object.keys(hh_flags)) {
          allDates.add(date);
          if (date < ANALYSIS_START) continue;
          if (hh_flags[date]) hh_counts[date] = (hh_counts[date]||0) + 1;
          if (ll_flags[date]) ll_counts[date] = (ll_counts[date]||0) + 1;
        }
      } catch (err) {
        console.error(`⚠️  ${sym}: ${err.message}`);
      }
    })
  ));

  // 4) build output rows
  const output = Array.from(allDates)
    .filter(d => d >= ANALYSIS_START)
    .sort((a,b) => new Date(a) - new Date(b))
    .map(date => ({
      date,
      hh_count:  hh_counts[date] || 0,
      ll_count:  ll_counts[date] || 0,
      net_count: (hh_counts[date]||0) - (ll_counts[date]||0)
    }));

  // 5) write CSV
  await createObjectCsvWriter({
    path: 'hh_ll_net_90days.csv',
    header: [
      { id:'date',      title:'date' },
      { id:'hh_count',  title:'hh_count' },
      { id:'ll_count',  title:'ll_count' },
      { id:'net_count', title:'net_count' }
    ]
  }).writeRecords(output);

  console.log(`💾  hh_ll_net_90days.csv  (${output.length} rows)`);
})();
