'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync('public/pricing.js', 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await wait(); assert.ok(check()); }

test('pricing client sends no wallet data, coalesces refreshes and rejects invalid rates', async () => {
  const dom = new JSDOM('', { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window; w.AbortSignal = global.AbortSignal;
  let resolveFetch; const calls = [];
  w.fetch = (url, options) => { calls.push({ url, options }); return new Promise(resolve => { resolveFetch = resolve; }); };
  let updates = 0; w.addEventListener('pricing:update', () => updates++);
  w.eval(script);
  const a = w.pricing.refresh(); const b = w.pricing.refresh();
  assert.equal(a, b); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/market');
  assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
  resolveFetch({ ok: true, json: async () => ({ currency: 'INR', usdToInr: 83.5, prices: { bnb: 600 } }) });
  await a; assert.equal(w.pricing.snapshot().data.usdToInr, 83.5); assert.ok(updates >= 2);
  const next = w.pricing.refresh();
  resolveFetch({ ok: true, json: async () => ({ currency: 'INR', usdToInr: '83', prices: {} }) });
  await next; assert.equal(w.pricing.snapshot().data, null); assert.equal(w.pricing.snapshot().loading, false);
  w.dispatchEvent(new w.Event('pagehide')); dom.window.close();
});

test('a late pre-navigation response cannot replace or duplicate a newer pricing request', async () => {
  const dom = new JSDOM('', { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window; w.AbortSignal = global.AbortSignal; const resolvers = [];
  w.fetch = () => new Promise(resolve => { resolvers.push(resolve); });
  w.eval(script); w.dispatchEvent(new w.Event('pagehide'));
  w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(resolvers.length, 2);
  resolvers[0]({ ok: true, json: async () => ({ currency: 'INR', usdToInr: 10, prices: {} }) });
  await wait(); const latest = w.pricing.refresh(); assert.equal(resolvers.length, 2);
  resolvers[1]({ ok: true, json: async () => ({ currency: 'INR', usdToInr: 83, prices: {} }) });
  await latest; assert.equal(w.pricing.snapshot().data.usdToInr, 83);
  w.dispatchEvent(new w.Event('pagehide')); dom.window.close();
});

test('an unresolved pricing response cannot restore old data after leaving the page', async () => {
  const dom = new JSDOM('', { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window; w.AbortSignal = global.AbortSignal; let resolveFetch;
  w.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  w.eval(script); w.dispatchEvent(new w.Event('pagehide'));
  resolveFetch({ ok: true, json: async () => ({ currency: 'INR', usdToInr: 83, prices: {} }) });
  await until(() => resolveFetch); await wait();
  assert.equal(w.pricing.snapshot().data, null);
  dom.window.close();
});
