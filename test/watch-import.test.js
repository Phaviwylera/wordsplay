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
  await wait();
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
