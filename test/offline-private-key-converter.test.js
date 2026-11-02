'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { Wallet } = require('ethers');

const template = fs.readFileSync('src/offline-private-key-converter.template.html', 'utf8');
const bundle = esbuild.buildSync({
  entryPoints: ['src/offline-private-key-converter.js'], bundle: true,
  platform: 'browser', format: 'iife', target: ['es2022'], minify: true, write: false,
}).outputFiles[0].text;
const marker = '/* OFFLINE_CONVERTER_BUNDLE */';
const standalone = template.replace(marker, bundle.replace(/<\/script/gi, '<\\/script'));

function setup(url) {
  const dom = new JSDOM(standalone, { url, runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = async () => { throw new Error('Offline converter must not fetch'); };
  window.XMLHttpRequest = class { send() { throw new Error('Offline converter must not make XHR requests'); } };
  let csvOutput = '';
  window.Blob = class { constructor(parts, options) { csvOutput = parts.join(''); this.type = options?.type; } };
  window.URL.createObjectURL = () => 'blob:offline-test';
  window.URL.revokeObjectURL = () => {};
  window.eval(bundle);
  return { dom, window, document: window.document, csv: () => csvOutput };
}

const wait = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Offline converter test timed out');
    await wait();
  }
}

test('downloaded converter is a standalone no-network HTML file with strict offline gating', () => {
  const built = fs.readFileSync('public/offline-private-key-converter.html', 'utf8');
  assert.doesNotMatch(built, /OFFLINE_CONVERTER_BUNDLE/);
  assert.doesNotMatch(built, /<script\s+src=/i);
  assert.doesNotMatch(built, /\bfetch\s*\(/i);
  assert.doesNotMatch(built, /XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB/i);
  assert.match(built, /connect-src 'none'/);
  assert.match(built, /location\.protocol/);
  const { dom, document } = setup('https://wallet.example/offline-private-key-converter');
  try {
    assert.equal(document.getElementById('key-file').disabled, true);
    assert.equal(document.getElementById('convert').disabled, true);
    assert.equal(document.getElementById('converter').hidden, true);
    assert.equal(document.getElementById('offline-notice').hidden, false);
  } finally { dom.window.close(); }
});

test('dashboard serves the standalone converter only as a no-store download', { timeout: 15000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-offline-download-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Wallet viewer running on port (\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited during startup: ${code}`)); });
  });
  try {
    const response = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/offline-private-key-converter' }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-disposition'], /attachment.*walleto-offline-private-key-converter\.html/);
    assert.match(response.headers['content-security-policy'], /connect-src 'none'/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /Ethereum address converter/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('offline converter verifies address/key pairs and exports only deduplicated public addresses', async () => {
  const privateKey = `0x${'0'.repeat(63)}1`;
  const expectedAddress = new Wallet(privateKey).address;
  const mismatchAddress = `0x${'1'.repeat(40)}`;
  const content = `${expectedAddress}\t${privateKey}\n${expectedAddress}\t${privateKey}\n${mismatchAddress}\t${privateKey}\nnot-an-address\tnot-a-private-key\n`;
  const { dom, window, document, csv } = setup('file:///walleto-offline-private-key-converter.html');
  try {
    assert.equal(document.getElementById('converter').hidden, false);
    const consent = document.getElementById('offline-confirm');
    consent.checked = true; consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    const input = document.getElementById('key-file');
    assert.equal(input.disabled, false);
    const file = new window.File([content], 'private-keys.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'text', { value: async () => content });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    const convert = document.getElementById('convert');
    assert.equal(convert.disabled, false);
    convert.click();
    await until(() => !document.getElementById('download-csv').hidden);
    assert.equal(csv(), `ethereum\n${expectedAddress.toLowerCase()}\n`);
    assert.doesNotMatch(csv(), new RegExp(privateKey));
    assert.match(document.getElementById('status').textContent, /Verified 1 public addresses/i);
    assert.match(document.getElementById('status').textContent, /1 malformed rows/i);
    assert.match(document.getElementById('status').textContent, /1 address\/key mismatches/i);
    assert.match(document.getElementById('status').textContent, /1 duplicates/i);
    assert.doesNotMatch(document.body.textContent, new RegExp(privateKey));
    assert.equal(document.getElementById('download-csv').download, 'ethereum-public-addresses.csv');
    assert.equal(input.value, '');
  } finally { dom.window.close(); }
});
