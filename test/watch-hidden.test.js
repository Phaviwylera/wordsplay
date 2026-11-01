const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
const native = { type: 'native', name: 'Native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null };
const busd = { type: 'BEP-20', name: 'BUSD', symbol: 'BUSD', contract: '0xe9e7cea3dedca5984780bafc599bd69add087d56', rawBalance: '0', decimals: 18, price: null };
const address = '0x0000000000000000000000000000000000000001';
const result = (network, value = native) => network === 'bnb' ? { coverage: 'bnb-and-busd', assets: [value, busd] } : { assets: [value] };
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, timeout = 10000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for watch scan'); await wait(); }
}
function setup(saved, fetcher) {
  const dom = new JSDOM(html, { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.AbortSignal = global.AbortSignal;
  w.localStorage.setItem('walleto.wallets', JSON.stringify(saved));
  w.fetch = fetcher;
  w.scanDirect = async () => { throw new Error('provider unavailable'); };
  w.pricing = { snapshot: () => ({ data: { usdToInr: 83, prices: {} }, loading: false }), refresh: () => {} };
  w.eval(bundle); w.eval(app);
  return { dom, w, $: id => w.document.getElementById(id) };
}

test('a persisted hidden wallet becomes visible during a reload scan and stays visible on a positive or failed result', async () => {
  const pending = [];
  const ctx = setup([{ address, hidden: true }], url => new Promise(resolve => pending.push({ url, resolve })));
  const { dom, w, $ } = ctx;
  try {
    assert.equal(pending.length, 5);
    assert.equal($('wallet-count').textContent, '1', 'pending checks must not remain hidden');
    assert.equal($('restore-hidden').hidden, true);
    for (const task of pending) {
      const network = new URL(task.url, 'https://wallet.example').searchParams.get('network');
      const value = network === 'ethereum' ? { ...native, rawBalance: '1' } : native;
      task.resolve({ ok: true, json: async () => result(network, value) });
    }
    await until(() => !$('refresh').disabled);
    assert.equal($('wallet-count').textContent, '1');
    assert.match($('asset-list').textContent, /Native/);
    assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets'))[0].hidden, undefined);
  } finally { dom.window.close(); }

  const failed = setup([{ address, hidden: true }], async url => {
    const network = new URL(url, 'https://wallet.example').searchParams.get('network');
    return network === 'base' ? { ok: false, status: 400 } : { ok: true, json: async () => result(network) };
  });
  try {
    await until(() => !failed.$('refresh').disabled);
    assert.equal(failed.$('wallet-count').textContent, '1');
    assert.match(failed.$('wallet-list').textContent, /Incomplete/);
    assert.equal(failed.$('restore-hidden').hidden, true);
    assert.equal(JSON.parse(failed.w.localStorage.getItem('walleto.wallets'))[0].hidden, undefined);
  } finally { failed.dom.window.close(); }
});

test('restoring does not rescan, and refresh exposes pending and previous positive balances', async () => {
  let mode = 'zero'; let calls = 0; let waiting = [];
  const ctx = setup([{ address }], url => {
    calls++;
    const network = new URL(url, 'https://wallet.example').searchParams.get('network');
    if (mode === 'pending') return new Promise(resolve => waiting.push({ network, resolve }));
    if (mode === 'failed' && network === 'ethereum') return Promise.resolve({ ok: false, status: 400 });
    return Promise.resolve({ ok: true, json: async () => result(network) });
  });
  const { dom, w, $ } = ctx;
  try {
    await until(() => !$('refresh').disabled);
    assert.equal($('wallet-count').textContent, '0');
    assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets'))[0].hidden, true);
    assert.match($('restore-hidden').textContent, /\(1\)/);
    $('restore-hidden').click();
    assert.equal(calls, 5);
    assert.equal($('wallet-count').textContent, '1');
    assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets'))[0].hidden, undefined);

    mode = 'pending'; $('refresh').click();
    await until(() => waiting.length === 5);
    assert.equal($('wallet-count').textContent, '1');
    for (const task of waiting) task.resolve({ ok: true, json: async () => result(task.network, task.network === 'ethereum' ? { ...native, rawBalance: '1' } : native) });
    await until(() => !$('refresh').disabled);
    assert.equal($('wallet-count').textContent, '1');
    assert.equal($('restore-hidden').hidden, true);
    mode = 'failed'; $('refresh').click();
    await until(() => !$('refresh').disabled);
    assert.equal($('wallet-count').textContent, '1');
    assert.match($('wallet-list').textContent, /Incomplete/);
    assert.match($('asset-list').textContent, /previous balance/);
    assert.equal($('restore-hidden').hidden, true);
  } finally { dom.window.close(); }
});

test('Bitcoin and TRON zero results hide reversibly with a limited-coverage warning', async () => {
  const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const calls = [];
  const ctx = setup([{ address: btc }, { address: tron }], async url => {
    const network = new URL(url, 'https://wallet.example').searchParams.get('network'); calls.push(network);
    return { ok: true, json: async () => ({ coverage: 'native-only', assets: [native] }) };
  });
  const { dom, $, w } = ctx;
  try {
    await until(() => !$('refresh').disabled);
    assert.deepEqual(calls.sort(), ['bitcoin', 'tron']);
    assert.equal($('wallet-count').textContent, '0');
    assert.match($('restore-hidden').textContent, /\(2\)/);
    assert.match($('zero-help').textContent, /Bitcoin inscriptions may be missed/i);
    $('restore-hidden').click();
    assert.equal($('wallet-count').textContent, '2');
    assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 2);
  } finally { dom.window.close(); }
});

test('watch pagination counts visible wallets and resets when hidden records are restored', { timeout: 20000 }, async () => {
  const wallets = Array.from({ length: 205 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  const ctx = setup(wallets, async url => {
    const params = new URL(url, 'https://wallet.example').searchParams;
    const index = Number.parseInt(params.get('address').slice(-4), 16);
    const value = index % 2 ? { ...native, rawBalance: '1' } : native;
    return { ok: true, json: async () => result(params.get('network'), value) };
  });
  const { dom, $ } = ctx;
  try {
    await until(() => !$('refresh').disabled, 15000);
    assert.equal($('wallet-count').textContent, '103');
    assert.match($('restore-hidden').textContent, /\(102\)/);
    assert.match($('wallet-page-label').textContent, /1–100 of 103/);
    $('wallet-next').click();
    assert.match($('wallet-page-label').textContent, /101–103 of 103/);
    $('restore-hidden').click();
    assert.equal($('wallet-count').textContent, '205');
    assert.match($('wallet-page-label').textContent, /1–100 of 205/);
    $('wallet-next').click(); $('wallet-next').click();
    assert.match($('wallet-page-label').textContent, /201–205 of 205/);
  } finally { dom.window.close(); }
});

test('adding an already tracked hidden address restores it without duplicating or rescanning', async () => {
  let calls = 0;
  const ctx = setup([{ address }], async url => {
    calls++;
    const network = new URL(url, 'https://wallet.example').searchParams.get('network');
    return { ok: true, json: async () => result(network) };
  });
  const { dom, w, $ } = ctx;
  try {
    await until(() => !$('refresh').disabled);
    assert.equal($('wallet-count').textContent, '0');
    $('wallet-address').value = address;
    $('address-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.match($('import-status').textContent, /previously hidden address is now visible/i);
    assert.equal($('wallet-count').textContent, '1');
    assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
    assert.equal(calls, 5);
  } finally { dom.window.close(); }
});
