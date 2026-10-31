const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { Wallet } = require('ethers');

const html = fs.readFileSync('public/index.html', 'utf8');
const background = fs.readFileSync('public/background.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
// A public test mnemonic; never fund this account.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const address = Wallet.fromPhrase(phrase).address;
const wait = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(check, timeout = 10000) {
  const started = Date.now();
  while (!(await check())) { if (Date.now() - started > timeout) throw new Error('End-to-end job timed out'); await wait(); }
}
function page(origin, savedJobs) {
  const dom = new JSDOM(html, { url: origin, runScripts: 'outside-only' }); const w = dom.window;
  if (savedJobs) w.localStorage.setItem('walleto.background-jobs', savedJobs);
  w.TextDecoder = global.TextDecoder;
  w.FileReader = class { constructor() { throw new Error('File content must not be read by browser JavaScript'); } };
  w.fetch = (resource, options) => fetch(new URL(resource, origin), options);
  w.confirm = () => true;
  w.eval(bundle); w.eval(background); w.eval(app);
  return dom;
}

test('real HTTP file upload continues after the browser disconnects and reconnects to dashboard results', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-e2e-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  // jsdom omits Origin on same-origin POSTs; real browsers send it. Add it in
  // this test-only transport shim. The HTTP security tests separately verify
  // that the real endpoint rejects missing and cross-origin upload headers.
  const source = `const http=require('http');const create=http.createServer;http.createServer=listener=>create((req,res)=>{if(req.method==='POST'&&!req.headers.origin&&/jsdom/.test(req.headers['user-agent']||''))req.headers.origin='http://'+req.headers.host;return listener(req,res)});const scanner=require('./lib/scanner');
    scanner.scanWallet=async (_address,network)=>{await new Promise(r=>setTimeout(r,500));return {assets:[{name:network==='bnb'?'BNB':'Ether',symbol:network==='bnb'?'BNB':'ETH',type:'native',rawBalance:'1000000000000000000',decimals:18,price:'2'}]}};
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let first; let reopened;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Wallet viewer running')) { clearTimeout(timeout); resolve(); } });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`server exited: ${code}`)); });
    });
    const origin = `http://127.0.0.1:${port}/`;
    first = page(origin); const w = first.window; const field = w.document.getElementById('seed-file');
    const file = new w.File([`${phrase}\ninvalid line`], 'wallets.txt', { type: 'text/plain' });
    file.slice = () => { throw new Error('Browser JavaScript must not slice the file'); };
    Object.defineProperty(field, 'files', { configurable: true, value: [file] });
    field.dispatchEvent(new w.Event('change', { bubbles: true }));
    try { await until(() => w.localStorage.getItem('walleto.background-jobs'), 10000); } catch (error) { throw new Error(`${error.message}: ${w.document.getElementById('import-status').textContent}; progress=${w.document.getElementById('progress-text').textContent}`); }
    assert.match(w.document.getElementById('import-status').textContent, /Upload confirmed/i);
    assert.equal(w.localStorage.getItem('walleto.wallets'), null);
    const saved = w.localStorage.getItem('walleto.background-jobs');
    const [{ id, token }] = JSON.parse(saved);
    first.window.close(); // No browser or upload connection remains.
    let result;
    await until(async () => {
      const response = await fetch(`${origin}api/background/jobs/${id}/dashboard?assetOffset=0&walletOffset=0&network=all`, { headers: { Authorization: `Bearer ${token}` } });
      result = await response.json(); return result.status === 'finished';
    });
    assert.equal(result.wallets, 1); assert.equal(result.invalid, 1); assert.equal(result.completed, 5);
    assert.equal(result.assetCount, 5); assert.equal(result.knownValue, 10);
    assert.equal(JSON.stringify(result).includes(phrase), false);
    reopened = page(origin, saved); const v = reopened.window;
    await until(() => v.document.querySelectorAll('#asset-list .asset-open').length === 5);
    assert.equal(v.document.getElementById('wallet-count').textContent, '1');
    assert.equal(v.document.getElementById('asset-count').textContent, '5');
    assert.equal(v.document.getElementById('total-value').textContent, '$10.00');
    v.document.querySelector('#asset-list .asset-open').click();
    assert.equal(v.document.getElementById('asset-export-address').textContent, address);
    v.document.getElementById('asset-export-reveal').click();
    await until(() => v.document.getElementById('asset-export-phrase').textContent === phrase);
    reopened.window.close();
  } finally {
    first?.window.close(); reopened?.window.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
