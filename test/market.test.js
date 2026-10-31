'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketService, CRYPTO_URL, FX_URL } = require('../lib/market');
const { BUSD_BSC, usdPrice } = require('../lib/prices');

test('concurrent market requests are coalesced, cached and use observed BUSD and INR rates', async () => {
  let now = Date.parse('2026-01-10T12:00:00Z'); const calls = []; let offline = false;
  const at = Math.floor(now / 1000);
  const service = createMarketService({ now: () => now, fetcher: async url => {
    calls.push(url); await new Promise(resolve => setTimeout(resolve, 5));
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => url === FX_URL
      ? { result: 'success', base_code: 'USD', time_last_update_unix: at, rates: { INR: 83.5 } }
      : { binancecoin: { usd: 612.34, last_updated_at: at }, 'binance-peg-busd': { usd: 0.972, last_updated_at: at }, bitcoin: { usd: 91000, last_updated_at: at } } };
  } });
  const [first, second] = await Promise.all([service(), service()]);
  assert.deepEqual(first, second); assert.equal(calls.length, 2);
  assert.equal(first.currency, 'INR'); assert.equal(first.usdToInr, 83.5);
  assert.equal(first.prices.bnb, 612.34); assert.equal(first.prices.busd, 0.972); assert.equal(first.prices.trx, null);
  assert.deepEqual(new Set(calls), new Set([CRYPTO_URL, FX_URL]));
  await service(); assert.equal(calls.length, 2);
  offline = true; now += 31 * 60 * 1000;
  const cached = await service(); assert.equal(calls.length, 4);
  assert.equal(cached.prices.busd, 0.972); assert.equal(cached.usdToInr, 83.5);
  now += 2 * 60 * 60 * 1000;
  const expired = await service();
  assert.equal(expired.prices.busd, null); assert.equal(expired.prices.bnb, null);
  assert.equal(expired.usdToInr, 83.5);
  now += 3 * 24 * 60 * 60 * 1000;
  assert.equal((await service()).usdToInr, null);
});

test('bad, stale, missing or rate-limited provider data never invents prices or an INR rate', async () => {
  const now = Date.parse('2026-01-10T12:00:00Z'); let calls = 0;
  const at = Math.floor(now / 1000);
  const service = createMarketService({ now: () => now, fetcher: async url => {
    calls++;
    if (url === FX_URL) return { ok: true, json: async () => ({ result: 'success', base_code: 'EUR', time_last_update_unix: at, rates: { INR: 99 } }) };
    return { ok: true, json: async () => ({ binancecoin: { usd: -1, last_updated_at: at }, 'binance-peg-busd': { usd: 1, last_updated_at: at - 3 * 60 * 60 } }) };
  } });
  const data = await service();
  assert.equal(data.usdToInr, null); assert.equal(data.prices.bnb, null); assert.equal(data.prices.busd, null);
  await service(); assert.equal(calls, 2, 'failed lookups are throttled');
  const offline = createMarketService({ now: () => now, fetcher: async () => ({ ok: false, status: 429 }) });
  const result = await offline();
  assert.equal(result.usdToInr, null); assert.ok(Object.values(result.prices).every(value => value === null));
});

test('quotes identify canonical BUSD by contract and do not price spoofed symbols or collectibles', () => {
  const quotes = { bnb: 600, busd: 0.97, eth: 2000 };
  assert.equal(usdPrice({ type: 'native', symbol: 'BNB', price: null }, 'bnb', quotes), 600);
  assert.equal(usdPrice({ type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC.toUpperCase(), price: null }, 'bnb', quotes), 0.97);
  assert.equal(usdPrice({ type: 'BEP-20', symbol: 'BUSD', contract: '0x123', price: null }, 'bnb', quotes), null);
  assert.equal(usdPrice({ type: 'ERC-721', price: 123 }, 'ethereum', quotes), null);
  assert.equal(usdPrice({ type: 'native', price: '4' }, 'ethereum', {}), 4);
  assert.equal(usdPrice({ type: 'token', price: -1 }, 'base', {}), null);
  assert.equal(usdPrice({ type: 'token', price: '  ' }, 'base', {}), null);
  assert.equal(usdPrice({ type: 'token', price: '0x2' }, 'base', {}), null);
  assert.equal(usdPrice({ type: 'token', price: '1.25e-2' }, 'base', {}), 0.0125);
  assert.equal(usdPrice({ type: 'token', price: '0' }, 'base', {}), 0);
});

test('market API is read-only, uncached in transit and handles service failure', async () => {
  const market = require('../lib/market'); const original = market.getMarket; const handler = require('../api/market');
  const makeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    market.getMarket = async () => ({ currency: 'INR', usdToInr: 83, prices: {} });
    const ok = makeRes(); await handler({ method: 'GET' }, ok);
    assert.equal(ok.code, 200); assert.equal(ok.body.usdToInr, 83); assert.equal(ok.headers['Cache-Control'], 'no-store');
    const rejected = makeRes(); await handler({ method: 'POST' }, rejected); assert.equal(rejected.code, 405);
    market.getMarket = async () => { throw new Error('down'); };
    const unavailable = makeRes(); await handler({ method: 'GET' }, unavailable); assert.equal(unavailable.code, 503);
  } finally { market.getMarket = original; }
});
