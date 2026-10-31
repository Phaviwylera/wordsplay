const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { Wallet, Mnemonic } = require('ethers');

// Public test phrases; never fund these accounts.
const phrase1 = 'test test test test test test test test test test test junk';
const phrase2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const address1 = Wallet.fromPhrase(phrase1).address;
const address2 = Wallet.fromPhrase(phrase2).address;
const zeroNative = { name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: '0', decimals: 18, price: null };
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
function setup() {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const requests = [];
  w.AbortSignal = global.AbortSignal;
  w.TextDecoder = global.TextDecoder;
  w.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ assets: [zeroNative] }) }; };
  w.eval(bundle);
  w.eval(fs.readFileSync('public/app.js', 'utf8'));
  return { dom, w, requests, $: id => w.document.getElementById(id) };
}
function submit(w, form) { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
const wait = () => new Promise(resolve => setTimeout(resolve, 60));

test('generates a valid phrase locally and scans it only after submission', async () => {
  const { dom, w, $, requests } = setup();
  // Public deterministic test entropy, never use for real funds.
  w.crypto.getRandomValues = bytes => { bytes.fill(0); return bytes; };
  $('generate-phrase').click();
  const phrase = $('seed-phrases').value;
  assert.equal(phrase, phrase2);
  assert.equal(phrase.split(' ').length, 12);
  assert.equal(Mnemonic.isValidMnemonic(phrase), true);
  assert.equal(requests.length, 0);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  submit(w, $('seed-form'));
  for (let i = 0; i < 100 && (!w.localStorage.getItem('walleto.wallets') || $('refresh').disabled); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address2]);
  assert.equal($('seed-phrases').value, '');
  assert.equal(requests.length, 5);
  assert.ok(requests.every(url => !url.includes('abandon')));
  assert.equal(w.localStorage.getItem('walleto.wallets').includes(phrase), false);
  assert.match($('wallet-list').textContent, /Scanned/);
  dom.window.close();
});

test('generation appends without overwriting and fails closed if secure randomness fails', () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = phrase1;
  w.crypto.getRandomValues = bytes => { bytes.fill(0); return bytes; };
  $('generate-phrase').click();
  assert.equal($('seed-phrases').value, `${phrase1}\n${phrase2}`);
  w.crypto.getRandomValues = () => { throw new Error('unavailable'); };
  $('generate-phrase').click();
  assert.equal($('seed-phrases').value, `${phrase1}\n${phrase2}`);
  assert.match($('import-status').textContent, /secure randomness is unavailable/i);
  assert.equal(requests.length, 0);
  dom.window.close();
});

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
  assert.equal(requests.length, 10);
  assert.ok(requests.every(url => !url.includes('test') && !url.includes('abandon')));
  assert.equal($('wallet-list').querySelector('strong').textContent, address1);
  dom.window.close();
});

test('extracts labeled pasted phrases and scans both addresses', async () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = `Wallet 1: ${phrase1}\n2. ${phrase2}`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 40 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address1, address2]);
  assert.equal(requests.length, 10);
  assert.match($('import-status').textContent, /2 wallets added/);
  dom.window.close();
});

test('address input validates, avoids duplicates and uses the address as the label', async () => {
  const { dom, w, $, requests } = setup();
  $('wallet-address').value = 'bad'; submit(w, $('address-form'));
  assert.match($('import-status').textContent, /valid Bitcoin, TRON or EVM/);
  $('wallet-address').value = address1; submit(w, $('address-form'));
  $('wallet-address').value = address1.toLowerCase(); submit(w, $('address-form'));
  await wait();
  assert.match($('import-status').textContent, /already being tracked/);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assert.equal($('wallet-list').querySelector('strong').textContent, address1);
  assert.equal(requests.length, 5);
  dom.window.close();
});

test('imports pasted Windows line endings with one 12-word phrase per line', async () => {
  const { dom, w, $, requests } = setup();
  // These are public test mnemonics, not user-supplied phrases.
  $('seed-phrases').value = `${phrase1}\r\n${phrase2}\r\n`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 40 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  const stored = w.localStorage.getItem('walleto.wallets');
  assert.deepEqual(JSON.parse(stored).map(item => item.address), [address1, address2]);
  assert.match($('import-status').textContent, /2 wallets added/);
  assert.equal(requests.length, 10);
  assert.equal(stored.includes(phrase1), false);
  assert.equal(stored.includes(phrase2), false);
  assert.ok(requests.every(url => !url.includes('test') && !url.includes('abandon')));
  dom.window.close();
});

test('imports more than 50 pasted phrases and bounds foreground scan concurrency', { timeout: 60000 }, async () => {
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
    return { ok: true, json: async () => ({ assets: [zeroNative] }) };
  };
  $('seed-phrases').value = `${phrases.join('\n')}\n${phrases[0]}\ninvalid`;
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
  assert.equal(requests.length, 55 * 5);
  assert.ok(maxActive <= 8, `at most eight simultaneous scans, observed ${maxActive}`);
  assert.ok(requests.every(url => !phrases.some(phrase => url.includes(phrase))));
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
  assert.equal(requests.length, 5);
  $('wallet-list').querySelector('button').click();
  await wait();
  assert.equal(cancelled, 5);
  assert.equal(requests.length, 5);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 0);
  assert.equal($('refresh').disabled, true);
  dom.window.close();
});

test('limits invalid-line details while reporting the full invalid count', async () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = `${phrase1}\n${Array(25).fill('invalid words').join('\n')}`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 100 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.match($('import-status').textContent, /invalid lines 2, 3/);
  assert.match($('import-status').textContent, /and 5 more/);
  assert.equal(requests.length, 5);
  dom.window.close();
});

test('paginates large wallet lists without dropping entries', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const wallets = Array.from({ length: 105 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  w.localStorage.setItem('walleto.wallets', JSON.stringify(wallets));
  w.fetch = async () => ({ ok: true, json: async () => ({ assets: [zeroNative] }) });
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
  w.fetch = async url => ({ ok: true, json: async () => ({ assets: url.includes('network=bnb') ? [zeroNative] : Array(26).fill(asset) }) });
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

test('shows network progress and ticks only successfully scanned wallets', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }, { address: address2 }]));
  const pending = [];
  w.fetch = url => new Promise(resolve => pending.push({ url, resolve }));
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  assert.equal(pending.length, 8);
  assert.equal($('progress-percent').textContent, '0%');
  for (const req of pending.filter(item => item.url.includes(address1))) req.resolve({ ok: true, json: async () => ({ assets: [zeroNative] }) });
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal($('progress-percent').textContent, '50%');
  assert.equal($('progress-bar').value, 50);
  assert.match($('wallet-list').children[0].textContent, /✓ Scanned/);
  assert.doesNotMatch($('wallet-list').children[1].textContent, /✓ Scanned/);
  assert.equal($('remove-zero').disabled, true);
  for (const req of pending.filter(item => item.url.includes(address2))) req.resolve({ ok: true, json: async () => ({ assets: [zeroNative] }) });
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal($('progress-percent').textContent, '100%');
  assert.match($('remove-zero').textContent, /\(0\)/);
  assert.equal($('remove-zero').disabled, true);
  assert.equal($('remove-zero').hidden, false);
  dom.window.close();
});

test('bulk removal excludes incomplete native-only coverage and failed or positive balances', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const wallets = Array.from({ length: 6 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  w.localStorage.setItem('walleto.wallets', JSON.stringify(wallets));
  const requests = [];
  w.confirm = () => true;
  w.fetch = async url => {
    requests.push(url);
    const query = new URL(url, 'https://wallet.example').searchParams;
    const index = wallets.findIndex(item => item.address === query.get('address'));
    if (index === 3 && query.get('network') === 'base') return { ok: false };
    if (index === 4 && query.get('network') === 'base') return { ok: true, json: async () => ({ assets: [{ ...zeroNative, rawBalance: null }] }) };
    const assets = [zeroNative];
    if (index === 1) assets.push({ name: 'Tiny', symbol: 'T', type: 'ERC-20', rawBalance: '1', decimals: 100, price: null });
    if (index === 2) assets.push({ name: 'Collectible', symbol: 'NFT', type: 'ERC-721', rawBalance: '1', decimals: 0, price: null });
    if (index === 5) assets.push({ name: 'Unpriced', symbol: 'U', type: 'ERC-20', rawBalance: '10', decimals: 0, price: null });
    return { ok: true, json: async () => ({ assets }) };
  };
  w.scanDirect = async () => { throw new Error('Indexer unavailable'); };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal($('progress-percent').textContent, '100%');
  assert.match($('progress-text').textContent, /errors/);
  assert.match($('wallet-list').children[3].textContent, /Incomplete/);
  assert.match($('wallet-list').children[4].textContent, /Incomplete/);
  assert.match($('remove-zero').textContent, /\(0\)/);
  assert.match($('zero-help').textContent, /native-only coverage/);
  const scannedRequests = requests.length;
  $('remove-zero').click();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), wallets.map(item => item.address));
  assert.equal(requests.length, scannedRequests, 'does not rescan remaining wallets');
  assert.equal($('remove-zero').disabled, true);
  dom.window.close();
});

test('bulk removal remains unavailable with native-only coverage', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }]));
  w.confirm = () => false;
  w.fetch = async () => ({ ok: true, json: async () => ({ assets: [zeroNative] }) });
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  $('remove-zero').click();
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assert.match($('remove-zero').textContent, /\(0\)/);
  dom.window.close();
});

test('deduplicates saved addresses before scanning or bulk removal', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }, { address: address1.toLowerCase() }]));
  let calls = 0;
  w.confirm = () => true;
  w.fetch = async () => { calls++; return { ok: true, json: async () => ({ assets: [zeroNative] }) }; };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(calls, 5);
  assert.equal($('wallet-count').textContent, '1');
  assert.match($('remove-zero').textContent, /\(0\)/);
  assert.equal($('remove-zero').disabled, true);
  $('remove-zero').click();
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 2, 'disabled removal does not rewrite storage');
  dom.window.close();
});

test('imports pasted phrases across chunk boundaries without leaking input', { timeout: 60000 }, async () => {
  const { dom, w, $, requests } = setup();
  // Start the phrase near the end of a chunk and include a multi-byte label.
  const prefix = ' '.repeat(65529);
  $('seed-phrases').value = `${prefix}${phrase1}\r\n${' '.repeat(65530)}ウォレット: ${phrase2}`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 200 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address1, address2]);
  assert.match($('import-status').textContent, /2 wallets added/);
  assert.equal(requests.length, 10);
  assert.ok(requests.every(url => !url.includes('test') && !url.includes('abandon')));
  dom.window.close();
});

test('accepts pasted text beyond the former 256 KiB limit', { timeout: 60000 }, async () => {
  const { dom, w, $, requests } = setup();
  $('seed-phrases').value = `${' '.repeat(256 * 1024 + 1)}\n${phrase1}`;
  submit(w, $('seed-form'));
  for (let i = 0; i < 200 && !w.localStorage.getItem('walleto.wallets'); i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [address1]);
  assert.match($('import-status').textContent, /1 wallet added/);
  assert.equal(requests.length, 5);
  dom.window.close();
});

test('remove all is visible in the top bar and enabled when a wallet is added', async () => {
  const { dom, w, $ } = setup();
  const button = $('remove-all');
  assert.ok(button.closest('header.topbar'));
  assert.equal(w.document.querySelectorAll('#remove-all').length, 1);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  w.fetch = () => new Promise(() => {});
  $('wallet-address').value = address1; submit(w, $('address-form'));
  assert.equal(button.disabled, false, 'available while scanning');
  assert.match(button.textContent, /\(1\)/);
  dom.window.close();
});

test('remove all clears every page and cancels an ongoing scan without accepting late results', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  const wallets = Array.from({ length: 105 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
  w.localStorage.setItem('walleto.wallets', JSON.stringify(wallets));
  const requests = [];
  w.fetch = (url, options) => new Promise(resolve => requests.push({ url, signal: options.signal, resolve }));
  let confirmation;
  w.confirm = message => { confirmation = message; return true; };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  assert.equal(requests.length, 8);
  assert.equal($('remove-all').hidden, false);
  assert.equal($('remove-all').disabled, false);
  assert.match($('remove-all').textContent, /105/);
  $('wallet-next').click();
  $('remove-all').click();
  assert.match(confirmation, /105 wallets.*watch list.*does not delete your wallets or funds/i);
  assert.ok(requests.every(request => request.signal.aborted));
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')), []);
  assert.equal($('wallet-count').textContent, '0');
  assert.equal($('wallet-list').children.length, 0);
  assert.equal($('asset-list').children.length, 0);
  assert.equal($('scan-progress').hidden, true);
  assert.equal($('remove-all').hidden, false);
  assert.equal($('remove-all').disabled, true);
  assert.equal($('refresh').disabled, true);
  const asset = { ...zeroNative, rawBalance: '1000000000000000000', price: '100' };
  for (const request of requests) request.resolve({ ok: true, json: async () => ({ assets: [asset] }) });
  await wait();
  assert.equal(requests.length, 8, 'queued requests never start');
  assert.equal($('wallet-count').textContent, '0');
  assert.equal($('asset-count').textContent, '0');
  assert.equal($('total-value').textContent, '$0.00');
  dom.window.close();
});

test('remove all confirmation can be declined without interrupting the scan', async () => {
  const { dom, w, $ } = setup();
  w.fetch = () => new Promise(() => {});
  w.confirm = () => false;
  $('wallet-address').value = address1; submit(w, $('address-form'));
  $('remove-all').click();
  assert.equal($('wallet-count').textContent, '1');
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assert.equal($('scan-progress').hidden, false);
  assert.equal($('refresh').disabled, true);
  dom.window.close();
});

test('remove all warns when removal cannot be saved in browser storage', async () => {
  const { dom, w, $ } = setup();
  $('wallet-address').value = address1; submit(w, $('address-form'));
  w.confirm = () => true;
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key === 'walleto.wallets') throw new Error('storage unavailable');
    return setItem.call(this, key, value);
  };
  $('remove-all').click();
  assert.equal($('wallet-count').textContent, '0');
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assert.match($('import-status').textContent, /could not save.*may return after a reload/i);
  assert.equal($('import-status').classList.contains('error'), true);
  dom.window.close();
});

test('retry failed checks preserves successful balances and retries only failures', async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }, { address: address2 }]));
  let fail = true;
  const requests = [];
  w.fetch = async url => {
    const params = new URL(url, 'https://wallet.example').searchParams;
    requests.push({ address: params.get('address'), network: params.get('network') });
    if (fail && params.get('address') === address1 && params.get('network') === 'base') return { ok: false, status: 400 };
    return { ok: true, json: async () => ({ assets: [params.get('network') !== 'bnb' && params.get('address') === address2 ? { ...zeroNative, rawBalance: '1000000000000000000', price: '2' } : zeroNative] }) };
  };
  w.scanDirect = async () => { throw new Error('Indexer unavailable'); };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(requests.length, 10);
  assert.match($('scan-errors').textContent, /Base: 1.*unavailable.*not treated as zero/i);
  assert.equal($('retry-failed').hidden, false);
  assert.equal($('total-value').textContent, '$8.00');
  assert.match($('remove-zero').textContent, /\(0\)/);
  fail = false;
  $('retry-failed').click();
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(requests.length, 11);
  assert.deepEqual(requests[10], { address: address1, network: 'base' });
  assert.equal($('total-value').textContent, '$8.00');
  assert.equal($('progress-percent').textContent, '100%');
  assert.equal($('retry-failed').hidden, true);
  assert.match($('wallet-list').children[0].textContent, /✓ Scanned/);
  assert.match($('remove-zero').textContent, /\(0\)/);
  dom.window.close();
});

test('automatically retries transient rate limits and reports remaining rate-limited checks', { timeout: 10000 }, async () => {
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: address1 }]));
  const calls = {};
  w.fetch = async url => {
    const network = new URL(url, 'https://wallet.example').searchParams.get('network');
    calls[network] = (calls[network] || 0) + 1;
    if (network === 'base' || (network === 'ethereum' && calls[network] === 1)) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ assets: [zeroNative] }) };
  };
  w.scanDirect = async () => { throw Object.assign(new Error('Indexer returned 429'), { status: 429 }); };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(calls.ethereum, 2);
  assert.equal(calls.base, 2);
  assert.match($('progress-detail').textContent, /1 failed/);
  assert.match($('scan-errors').textContent, /Base: 1.*rate limiting/i);
  assert.match($('wallet-list').textContent, /Incomplete/);
  assert.equal($('remove-zero').disabled, true);
  dom.window.close();
});

test('canceling a scan during transient retry backoff prevents further requests', async () => {
  const { dom, w, $ } = setup();
  let calls = 0;
  w.fetch = async () => { calls++; return { ok: false, status: 429 }; };
  w.scanDirect = async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); };
  w.confirm = () => true;
  $('wallet-address').value = address1; submit(w, $('address-form'));
  await wait();
  assert.equal(calls, 5);
  $('remove-all').click();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(calls, 5);
  assert.equal($('wallet-count').textContent, '0');
  dom.window.close();
});

test('imports Bitcoin and TRON addresses and scans only the correct networks', async () => {
  const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const { dom, w, $, requests } = setup();
  w.fetch = async url => {
    requests.push(url);
    const params = new URL(url, 'https://wallet.example').searchParams;
    const symbol = params.get('network') === 'bitcoin' ? 'BTC' : params.get('network') === 'tron' ? 'TRX' : params.get('network') === 'bnb' ? 'BNB' : 'ETH';
    return { ok: true, json: async () => ({ coverage: symbol === 'ETH' ? 'complete' : 'native-only', assets: [{ name: symbol, symbol, type: 'native', rawBalance: '1', decimals: symbol === 'BTC' ? 8 : 6, price: null }] }) };
  };
  $('wallet-address').value = btc.toUpperCase(); submit(w, $('address-form'));
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')).map(item => item.address), [btc]);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].includes('network=bitcoin'));
  assert.match($('asset-list').textContent, /BTC/);
  assert.match($('asset-list').textContent, /0\.00000001/);
  assert.equal($('total-value').textContent, '—');
  assert.equal($('remove-zero').disabled, true);
  $('wallet-address').value = btc; submit(w, $('address-form'));
  assert.match($('import-status').textContent, /already being tracked/);
  $('wallet-address').value = tron; submit(w, $('address-form'));
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  const recent = requests.slice(1).map(url => new URL(url, 'https://wallet.example').searchParams.get('network'));
  assert.deepEqual(recent.sort(), ['bitcoin', 'tron']);
  assert.equal($('wallet-count').textContent, '2');
  assert.match($('asset-list').textContent, /TRX/);
  assert.match($('wallet-list').textContent, /native-only coverage/);
  dom.window.close();
});

test('EVM wallet scans BNB Smart Chain and reports incomplete native-only coverage', async () => {
  const { dom, w, $, requests } = setup();
  w.fetch = async url => {
    requests.push(url);
    const network = new URL(url, 'https://wallet.example').searchParams.get('network');
    const asset = network === 'bnb' ? { name: 'BNB', symbol: 'BNB', type: 'native', rawBalance: '1000000000000000000', decimals: 18, price: null } : zeroNative;
    return { ok: true, json: async () => ({ assets: [asset] }) };
  };
  $('wallet-address').value = address1; submit(w, $('address-form'));
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(requests.length, 5);
  assert.ok(requests.some(url => url.includes('network=bnb')));
  assert.match($('asset-list').textContent, /BNB/);
  assert.equal($('total-value').textContent, '—');
  assert.equal($('remove-zero').disabled, true);
  assert.match($('zero-help').textContent, /native-only coverage/);
  dom.window.close();
});

test('a failed Bitcoin check can be retried without losing successful mixed-network results', async () => {
  const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('walleto.wallets', JSON.stringify([{ address: btc }, { address: tron }, { address: address1 }]));
  let fail = true; const requests = [];
  w.fetch = async url => {
    const network = new URL(url, 'https://wallet.example').searchParams.get('network'); requests.push(network);
    if (network === 'bitcoin' && fail) return { ok: false, status: 400 };
    const symbol = network === 'bitcoin' ? 'BTC' : network === 'tron' ? 'TRX' : 'ETH';
    return { ok: true, json: async () => ({ assets: [{ ...zeroNative, symbol, rawBalance: '1', decimals: 0 }] }) };
  };
  w.scanDirect = async () => { throw new Error('Provider unavailable'); };
  w.eval(bundle); w.eval(fs.readFileSync('public/app.js', 'utf8'));
  const $ = id => w.document.getElementById(id);
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(requests.length, 7);
  assert.match($('scan-errors').textContent, /Bitcoin: 1/);
  assert.match($('wallet-list').children[0].textContent, /Incomplete/);
  assert.match($('asset-list').textContent, /TRX/);
  fail = false; $('retry-failed').click();
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal(requests.length, 8);
  assert.equal(requests[7], 'bitcoin');
  assert.match($('asset-list').textContent, /BTC/);
  assert.match($('asset-list').textContent, /TRX/);
  assert.equal($('remove-zero').disabled, true);
  dom.window.close();
});

test('native-only L2 fallback remains incomplete and retry replaces rather than duplicates results', async () => {
  const { dom, w, $ } = setup();
  let full = false;
  const native = { ...zeroNative, rawBalance: '1000000000000000000' };
  w.scanDirect = async () => { throw new Error('indexer unavailable'); };
  w.fetch = async url => {
    const network = new URL(url, w.location.href).searchParams.get('network');
    if (network === 'optimism') return { ok: true, json: async () => full ? { assets: [{ ...native, price: '100' }] } : { coverage: 'native-only', assets: [native] } };
    return { ok: true, json: async () => ({ assets: [zeroNative] }) };
  };
  $('wallet-address').value = address1; submit(w, $('address-form'));
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal($('asset-list').querySelectorAll('tr').length, 1);
  assert.match($('scan-errors').textContent, /Optimism: 1.*Native balance only; token and NFT data unavailable/);
  assert.match($('wallet-list').textContent, /Incomplete/);
  assert.equal($('retry-failed').hidden, false);
  full = true; $('retry-failed').click();
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  assert.equal($('asset-list').querySelectorAll('tr').length, 1);
  assert.equal($('total-value').textContent, '$100.00');
  assert.equal($('retry-failed').hidden, true);
  dom.window.close();
});

test('scan errors show the specific reason for each network', async () => {
  const { dom, w, $ } = setup();
  w.scanDirect = async (_address, network) => {
    if (network === 'ethereum') throw new Error('Invalid balance from indexer');
    throw new Error('Unexpected network');
  };
  w.fetch = async url => {
    const network = new URL(url, w.location.href).searchParams.get('network');
    if (network === 'ethereum') return { ok: false, status: 400 };
    if (network === 'arbitrum') return { ok: true, json: async () => ({ coverage: 'native-only', assets: [zeroNative] }) };
    return { ok: true, json: async () => ({ assets: [zeroNative] }) };
  };
  $('wallet-address').value = address1; submit(w, $('address-form'));
  for (let i = 0; i < 100 && $('refresh').disabled; i++) await wait();
  const message = $('scan-errors').textContent;
  assert.match(message, /Ethereum: 1 — Invalid or incomplete indexer data \(1\)/);
  assert.match(message, /Arbitrum: 1 — Native balance only; token and NFT data unavailable \(1\)/);
  assert.match(message, /not treated as zero/);
  dom.window.close();
});
