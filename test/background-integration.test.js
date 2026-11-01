const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  // jsdom uses Node's fetch here, which does not add a browser Origin header.
  w.fetch = (resource, options = {}) => fetch(new URL(resource, origin), { ...options, headers: { ...options.headers, ...(options.method === 'POST' ? { Origin: new URL(origin).origin } : {}) } });
  w.confirm = () => true;
  w.eval(bundle); w.eval(background); w.eval(app);
  return dom;
}

test('real HTTP file upload continues after the browser disconnects and reconnects to dashboard results', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-e2e-'));
  // jsdom omits Origin on same-origin POSTs; real browsers send it. Add it in
  // this test-only transport shim. The HTTP security tests separately verify
  // that the real endpoint rejects missing and cross-origin upload headers.
  const source = `const http=require('http');const create=http.createServer;http.createServer=listener=>create((req,res)=>{if(req.method==='POST'&&!req.headers.origin&&/jsdom/.test(req.headers['user-agent']||''))req.headers.origin='http://'+req.headers.host;return listener(req,res)});const scanner=require('./lib/scanner');
    scanner.scanWallet=async (_address,network)=>{await new Promise(r=>setTimeout(r,500));const assets=[{name:network==='bnb'?'BNB':'Ether',symbol:network==='bnb'?'BNB':'ETH',type:'native',rawBalance:'1000000000000000000',decimals:18,price:'2'}];if(network==='bnb')assets.push({name:'Binance-Peg BUSD',symbol:'BUSD',type:'BEP-20',contract:'0xe9e7cea3dedca5984780bafc599bd69add087d56',rawBalance:'2000000000000000000',decimals:18,price:null});return {assets,coverage:network==='bnb'?'bnb-and-busd':'complete'}};
    require('./lib/market').getMarket=async()=>({currency:'INR',usdToInr:83,prices:{bnb:600,busd:0.97}});
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let first; let reopened; let reconnected;
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Wallet viewer running on port (\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
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
    assert.equal(result.assetCount, 6); assert.ok(Math.abs(result.knownValue - 609.94) < 1e-9);
    assert.equal(JSON.stringify(result).includes(phrase), false);
    reopened = page(origin, saved); const v = reopened.window;
    await until(() => v.document.querySelectorAll('#asset-list .asset-open').length === 6);
    assert.equal(v.document.getElementById('wallet-count').textContent, '1');
    assert.equal(v.document.getElementById('asset-count').textContent, '6');
    assert.equal(v.document.getElementById('total-value').textContent, '₹50,625.02');
    assert.match(v.document.getElementById('asset-list').textContent, /BUSD/);
    v.document.querySelector('#asset-list .asset-open').click();
    assert.equal(v.document.getElementById('asset-export-address').textContent, address);
    v.document.getElementById('asset-export-reveal').click();
    await until(() => v.document.getElementById('asset-export-phrase').textContent === phrase);
    v.document.getElementById('asset-export-close').click();
    v.document.getElementById('file-refresh-bnb').click();
    await until(async () => {
      const response = await fetch(`${origin}api/background/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      return (await response.json()).status === 'scanning';
    });
    reopened.window.close(); // The new BNB/BUSD check continues on the server.
    await until(async () => {
      const response = await fetch(`${origin}api/background/jobs/${id}/dashboard?assetOffset=0&walletOffset=0&network=all`, { headers: { Authorization: `Bearer ${token}` } });
      result = await response.json(); return result.status === 'finished';
    });
    assert.equal(result.incomplete, 0); assert.equal(result.assetCount, 6);
    reconnected = page(origin, saved);
    await until(() => reconnected.window.document.getElementById('total-value').textContent === '₹50,625.02');
    assert.match(reconnected.window.document.getElementById('asset-list').textContent, /BUSD/);
  } finally {
    first?.window.close(); reopened?.window.close(); reconnected?.window.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished file shows balances before a slow INR quote and refreshes its total when pricing arrives', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-e2e-prices-'));
  const source = `let quote=null;let waiters=[];process.on('message',()=>{quote={currency:'INR',usdToInr:83,prices:{}};for(const resolve of waiters)resolve(quote);waiters=[]});require('./lib/market').getMarket=()=>quote?Promise.resolve(quote):new Promise(resolve=>waiters.push(resolve));
    require('./lib/scanner').scanWallet=async (_address,network)=>({assets:[{name:'Native',symbol:'ETH',type:'native',rawBalance:'1000000000000000000',decimals:18,price:'2'},...(network==='bnb'?[{name:'BUSD',symbol:'BUSD',type:'BEP-20',contract:'0xe9e7cea3dedca5984780bafc599bd69add087d56',rawBalance:'0',decimals:18,price:null}]:[])],...(network==='bnb'?{coverage:'bnb-and-busd'}:{})});
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let dom;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Wallet viewer running on port (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
    });
    const origin = `http://127.0.0.1:${port}/`;
    const uploaded = await fetch(`${origin}api/background/jobs`, { method: 'POST', headers: { Origin: origin.slice(0, -1), 'Content-Type': 'application/octet-stream' }, body: phrase });
    const { id, token } = await uploaded.json(); assert.equal(uploaded.status, 202);
    await until(async () => (await (await fetch(`${origin}api/background/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).status === 'finished');
    dom = page(origin, JSON.stringify([{ id, token }]));
    const w = dom.window; w.AbortSignal = global.AbortSignal;
    w.eval(fs.readFileSync('public/pricing.js', 'utf8'));
    await until(() => w.document.querySelectorAll('#asset-list .asset-open').length === 5);
    assert.equal(w.document.getElementById('total-value').textContent, '—');
    assert.match(w.document.getElementById('value-note').textContent, /INR exchange rate unavailable/i);
    child.send('release market quote');
    await until(() => w.document.getElementById('total-value').textContent === '₹830.00', 8000);
    assert.equal(w.document.querySelectorAll('#asset-list .asset-open').length, 5);
  } finally {
    dom?.window.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the private dashboard restores a hidden file wallet without deleting its checks', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-e2e-hidden-'));
  const source = `require('./lib/market').getMarket=async()=>({currency:'INR',usdToInr:83,prices:{}});
    require('./lib/scanner').scanWallet=async (_address,network)=>({assets:[{name:'Native',symbol:'ETH',type:'native',rawBalance:'0',decimals:18,price:null},...(network==='bnb'?[{name:'BUSD',symbol:'BUSD',type:'BEP-20',contract:'0xe9e7cea3dedca5984780bafc599bd69add087d56',rawBalance:'0',decimals:18,price:null}]:[])],...(network==='bnb'?{coverage:'bnb-and-busd'}:{})});
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let dom; let reopened;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Wallet viewer running on port (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
    });
    const origin = `http://127.0.0.1:${port}/`;
    const uploaded = await fetch(`${origin}api/background/jobs`, { method: 'POST', headers: { Origin: origin.slice(0, -1), 'Content-Type': 'application/octet-stream' }, body: phrase });
    assert.equal(uploaded.status, 202);
    const { id, token } = await uploaded.json();
    const authorization = { Authorization: `Bearer ${token}` };
    let status;
    await until(async () => { status = await (await fetch(`${origin}api/background/jobs/${id}`, { headers: authorization })).json(); return status.status === 'finished'; });
    assert.equal(status.hiddenWallets, 1); assert.equal(status.visibleWallets, 0); assert.equal(status.completed, 5);
    const saved = JSON.stringify([{ id, token }]);
    dom = page(origin, saved); const w = dom.window;
    await until(() => !w.document.getElementById('restore-hidden').hidden);
    assert.equal(w.document.getElementById('wallet-count').textContent, '0');
    assert.match(w.document.getElementById('zero-help').textContent, /recovery phrases.*discarded/i);
    w.document.getElementById('restore-hidden').click();
    await until(() => w.document.getElementById('wallet-count').textContent === '1');
    assert.match(w.document.getElementById('wallet-list').textContent, new RegExp(address));
    const results = await (await fetch(`${origin}api/background/jobs/${id}/results`, { headers: authorization })).json();
    assert.equal(results.checks.length, 5); assert.equal(results.hiddenWallets, 0);
    dom.window.close();
    reopened = page(origin, saved);
    await until(() => reopened.window.document.getElementById('wallet-count').textContent === '1');
    assert.equal(reopened.window.document.getElementById('restore-hidden').hidden, true);
  } finally {
    dom?.window.close(); reopened?.window.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
