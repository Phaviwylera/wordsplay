const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { Wallet } = require('ethers');

// Public test phrases; never fund these accounts.
const phrase1 = 'test test test test test test test test test test test junk';
const phrase2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const address1 = Wallet.fromPhrase(phrase1).address;
const address2 = Wallet.fromPhrase(phrase2).address;
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
function setup() {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const requests = [];
  w.AbortSignal = global.AbortSignal;
  w.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ assets: [] }) }; };
  w.eval(bundle);
  w.eval(fs.readFileSync('public/app.js', 'utf8'));
  return { dom, w, requests, $: id => w.document.getElementById(id) };
}
function submit(w, form) { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
const wait = () => new Promise(resolve => setTimeout(resolve, 60));

test('pasted phrases derive multiple addresses, reject invalid lines and deduplicate without storing secrets', async () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = `${phrase1}\n${phrase2}\n${phrase1}\ninvalid words`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 100 && (!w.localStorage.getItem('walleto.wallets') || $('refresh').disabled); i++) await wait();
  const saved = JSON.parse(w.localStorage.getItem('walleto.wallets'));
  assert.deepEqual(saved.map(item => item.address), [address1, address2]);
  assert.equal($('seed-phrases').value, '');
  assert.match($('import-status').textContent, /2 wallets added/);
  assert.match($('import-status').textContent, /1 duplicate skipped/);
  assert.match($('import-status').textContent, /invalid line 4/);
  assert.equal(w.localStorage.getItem('walleto.wallets').includes(phrase1), false);
  assert.equal(requests.length, 8);
  assert.ok(requests.every(url => !url.includes('test') && !url.includes('abandon')));
  assert.equal($('wallet-list').querySelector('strong').textContent, address1);
  dom.window.close();
});

test('extracts labeled phrases from a local text file and scans both addresses', async () => {
  const { dom, w, $, requests } = setup();
  const file = new w.File([`Wallet 1: ${phrase1}\n2. ${phrase2}`], 'wallets.txt', { type: 'text/plain' });
  Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
  submit(w, $('seed-form'));
  for (let i = 0; i < 40 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address1, address2]);
  assert.equal(requests.length, 8);
  assert.match($('import-status').textContent, /2 wallets added/);
  dom.window.close();
});

test('address input validates, avoids duplicates and uses the address as the label', async () => {
  const { dom, w, $, requests } = setup();
  $('wallet-address').value = 'bad'; submit(w, $('address-form'));
  assert.match($('import-status').textContent, /valid 0x/);
  $('wallet-address').value = address1; submit(w, $('address-form'));
  $('wallet-address').value = address1.toLowerCase(); submit(w, $('address-form'));
  await wait();
  assert.match($('import-status').textContent, /already being tracked/);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assert.equal($('wallet-list').querySelector('strong').textContent, address1);
  assert.equal(requests.length, 4);
  dom.window.close();
});

test('imports a plain two-line text file with one 12-word phrase per line', async () => {
  const { dom, w, $, requests } = setup();
  // These are public test mnemonics, not user-supplied phrases.
  const file = new w.File([`${phrase1}\r\n${phrase2}\r\n`], 'wallets.txt', { type: 'text/plain' });
  Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
  submit(w, $('seed-form'));
  for (let i = 0; i < 40 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  const stored = w.localStorage.getItem('walleto.wallets');
  assert.deepEqual(JSON.parse(stored).map(item => item.address), [address1, address2]);
  assert.match($('import-status').textContent, /2 wallets added/);
  assert.equal(requests.length, 8);
  assert.equal(stored.includes(phrase1), false);
  assert.equal(stored.includes(phrase2), false);
  assert.ok(requests.every(url => !url.includes('test') && !url.includes('abandon')));
  dom.window.close();
});

test('imports more than 50 distinct phrases from a text file and bounds scan concurrency', { timeout: 60000 }, async () => {
  const { Mnemonic } = require('ethers');
  const phrases = Array.from({ length: 55 }, (_, index) => {
    // Deterministic public test entropy. Never use these wallets for funds.
    const entropy = `0x${(index + 1).toString(16).padStart(32, '0')}`;
    return Mnemonic.fromEntropy(entropy).phrase;
  });
  const { dom, w, $, requests } = setup();
  let active = 0; let maxActive = 0;
  w.fetch = async url => {
    requests.push(url); active++; maxActive = Math.max(active, maxActive);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return { ok: true, json: async () => ({ assets: [] }) };
  };
  const file = new w.File([`${phrases.join('\n')}\n${phrases[0]}\ninvalid`], 'many.txt', { type: 'text/plain' });
  Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
  submit(w, $('seed-form'));
  for (let i = 0; i < 500 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  const stored = w.localStorage.getItem('walleto.wallets');
  assert.ok(stored, 'import finished and saved');
  assert.equal(JSON.parse(stored).length, 55);
  assert.match($('import-status').textContent, /55 wallets added/);
  assert.match($('import-status').textContent, /1 duplicate skipped/);
  assert.match($('import-status').textContent, /invalid line 57/);
  assert.ok(phrases.every(phrase => !stored.includes(phrase)));
  for (let i = 0; i < 200 && $('refresh').disabled; i++) await wait();
  assert.equal($('refresh').disabled, false, 'all network scans finished');
  assert.equal(requests.length, 55 * 4);
  assert.ok(maxActive <= 4, `at most four simultaneous scans, observed ${maxActive}`);
  assert.ok(requests.every(url => !phrases.some(phrase => url.includes(phrase))));
  dom.window.close();
});

test('reports the remaining file size limit and does not process an oversized file', async () => {
  const { dom, w, $, requests } = setup();
  const file = new w.File(['x'.repeat(25 * 1024 * 1024 + 1)], 'too-large.txt', { type: 'text/plain' });
  Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
  submit(w, $('seed-form'));
  await wait();
  assert.match($('import-status').textContent, /25 MiB/);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  assert.equal(requests.length, 0);
  dom.window.close();
});

test('cancels in-flight scans when a tracked wallet is removed', async () => {
  const { dom, w, $, requests } = setup();
  let cancelled = 0;
  w.fetch = (url, options) => {
    requests.push(url);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { cancelled++; reject(new Error('aborted')); }, { once: true });
    });
  };
  $('wallet-address').value = address1; submit(w, $('address-form'));
  assert.equal(requests.length, 4);
  $('wallet-list').querySelector('button').click();
  await wait();
  assert.equal(cancelled, 4);
  assert.equal(requests.length, 4);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 0);
  assert.equal($('refresh').disabled, true);
  dom.window.close();
});

test('accepts and processes a text file exactly 25 MiB', { timeout: 60000 }, async () => {
  const { dom, w, $, requests } = setup();
  const prefix = `${phrase1}\n`;
  const file = new w.File([prefix, ' '.repeat(25 * 1024 * 1024 - prefix.length)], 'large.txt', { type: 'text/plain' });
  assert.equal(file.size, 25 * 1024 * 1024);
  Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
  submit(w, $('seed-form'));
  for (let i = 0; i < 500 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address1]);
  assert.match($('import-status').textContent, /1 wallet added/);
  assert.equal(requests.length, 4);
  dom.window.close();
});

test('limits invalid-line details while reporting the full invalid count', async () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = `${phrase1}\n${Array(25).fill('invalid words').join('\n')}`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 100 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.match($('import-status').textContent, /invalid lines 2, 3/);
  assert.match($('import-status').textContent, /and 5 more/);
  assert.equal(requests.length, 4);
  dom.window.close();
});

test('paginates large wallet lists without dropping entries', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const wallets = Array.from({ length: 105 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  w.localStorage.setItem('walleto.wallets', JSON.stringify(wallets));
  w.fetch = async () => ({ ok: true, json: async () => ({ assets: [] }) });
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  assert.equal($('wallet-list').querySelectorAll('.wallet-row').length, 100);
  assert.match($('wallet-page-label').textContent, /1–100 of 105/);
  $('wallet-next').click();
  assert.equal($('wallet-list').querySelectorAll('.wallet-row').length, 5);
  assert.match($('wallet-page-label').textContent, /101–105 of 105/);
  assert.equal($('wallet-list').querySelector('strong').textContent, wallets[100].address);
  await wait(); dom.window.close();
});

test('calculates balances and paginates assets while scans complete', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }]));
  const asset = { name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: '1000000000000000000', decimals: 18, price: '2' };
  w.fetch = async () => ({ ok: true, json: async () => ({ assets: Array(26).fill(asset) }) });
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal($('total-value').textContent, '$208.00');
  assert.equal($('asset-count').textContent, '104');
  assert.equal($('asset-list').querySelectorAll('tr').length, 100);
  $('asset-next').click();
  assert.equal($('asset-list').querySelectorAll('tr').length, 4);
  assert.match($('asset-page-label').textContent, /101–104 of 104/);
  $('network-filter').value = 'base';
  $('network-filter').dispatchEvent(new w.Event('change'));
  assert.equal($('asset-list').querySelectorAll('tr').length, 26);
  assert.equal($('asset-pager').hidden, true);
  dom.window.close();
});

test('warns when browser storage is full instead of claiming the import was saved', async () => {
  const { dom, w, $ } = setup();
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key === 'walleto.wallets') throw new Error('quota exceeded');
    return setItem.call(this, key, value);
  };
  $('seed-phrases').value = phrase1; submit(w, $('seed-form'));
  for (let i = 0; i < 100 && !$('import-status').textContent.includes('storage'); i++) await wait();
  assert.match($('import-status').textContent, /storage is full or unavailable/);
  assert.match($('import-status').textContent, /only last this session/);
  assert.equal($('wallet-count').textContent, '1');
  dom.window.close();
});
