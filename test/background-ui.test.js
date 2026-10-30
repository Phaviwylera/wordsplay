const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('public/index.html', 'utf8');
const script = fs.readFileSync('public/background.js', 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 20));

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('background upload is blocked on a public HTTP origin', () => {
  const dom = new JSDOM(html, { url: 'http://203.0.113.1/', runScripts: 'outside-only' });
  dom.window.eval(script);
  dom.window.document.getElementById('background-start').click();
  assert.match(dom.window.document.getElementById('background-status').textContent, /SSH tunnel.*public HTTP/i);
  dom.window.close();
});

test('an acknowledged private upload lists each positive address and reveals only its matching phrase on demand', async () => {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8080/', runScripts: 'outside-only' });
  const w = dom.window; const id = 'a'.repeat(64); const token = 'b'.repeat(64);
  const credentials = { id, token };
  const results = { id, status: 'finished', wallets: 1, lines: 1, invalid: 0, total: 1, completed: 1, incomplete: 0, checks: [{ address: '0x123', network: 'ethereum', status: 'done', assets: [{ type: 'native', rawBalance: '1000000000000000000', decimals: 18, symbol: 'ETH' }] }] };
  const matches = { enabled: true, retained: true, total: 1, offset: 0, matches: [{ address: '0x123', checks: [{ network: 'ethereum', status: 'done', assets: [{ type: 'native', rawBalance: '1000000000000000000', decimals: 18, symbol: 'ETH' }] }] }] };
  let sentFile; let sentAuthorization; let confirmation = '';
  w.confirm = message => { confirmation = message; return true; };
  w.XMLHttpRequest = class {
    constructor() { this.upload = {}; }
    open(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/api/background/jobs'); }
    setRequestHeader(name, value) { assert.equal(name, 'Content-Type'); assert.equal(value, 'application/octet-stream'); }
    send(file) { sentFile = file; this.status = 202; this.responseText = JSON.stringify(credentials); this.onload(); }
  };
  w.fetch = async (url, options) => {
    sentAuthorization = options.headers.Authorization;
    if (url.includes('/results')) return { ok: true, json: async () => results };
    if (url.includes('/matches')) return { ok: true, json: async () => matches };
    if (url.includes('/phrase')) return { ok: true, json: async () => ({ phrase }) };
    throw new Error(`Unexpected request: ${url}`);
  };
  const file = new w.File(['public test data'], 'test.txt', { type: 'text/plain' });
  Object.defineProperty(w.document.getElementById('seed-file'), 'files', { configurable: true, value: [file] });
  w.eval(script);
  w.document.getElementById('background-start').click();
  await wait();
  assert.equal(sentFile, file);
  assert.match(confirmation, /retains phrases only for wallets with detected positive balances/i);
  assert.equal(sentAuthorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.background-job')), credentials);
  assert.match(w.document.getElementById('background-status').textContent, /finished/i);
  assert.match(w.document.getElementById('background-results').textContent, /1 ETH/);
  const cards = w.document.querySelectorAll('.background-match-card');
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /0x123/);
  assert.match(cards[0].textContent, /1 ETH/);
  assert.doesNotMatch(cards[0].textContent, new RegExp(phrase));
  const reveal = cards[0].querySelector('.background-reveal-button');
  reveal.click();
  await wait();
  assert.match(cards[0].textContent, new RegExp(phrase));
  cards[0].querySelector('.background-reveal-button').click();
  assert.doesNotMatch(cards[0].textContent, new RegExp(phrase));
  dom.window.close();
});
