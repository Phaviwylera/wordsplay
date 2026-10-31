const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { Wallet } = require('ethers');

const html = fs.readFileSync('public/index.html', 'utf8');
const background = fs.readFileSync('public/background.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
// Public test mnemonics; never fund these accounts.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const phrase2 = 'test test test test test test test test test test test junk';
const address = Wallet.fromPhrase(phrase).address;
const address2 = Wallet.fromPhrase(phrase2).address;
const id = 'a'.repeat(64); const token = 'b'.repeat(64);
const id2 = 'c'.repeat(64); const token2 = 'd'.repeat(64);
const native = { name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: '1000000000000000000', decimals: 18, price: '2' };
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, timeout = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('File dashboard UI did not finish'); await wait(); }
}
function setup({ url = 'http://127.0.0.1:8080/', savedJob = false, savedWallets = null, assets, wallets, incomplete = 0, getPhrase, dashboardHook, watchFetch } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window; const $ = id => w.document.getElementById(id);
  const requests = []; const xhrs = []; const blobs = []; const downloads = []; const confirmations = []; const revoked = [];
  let deriveCalls = 0; let directCalls = 0;
  let currentIncomplete = incomplete;
  const allAssets = assets || [{ address, network: 'ethereum', status: 'done', asset: native }];
  const allWallets = wallets || [{ address, total: 5, completed: 5, incomplete, hasAssets: true }];
  if (savedJob) w.localStorage.setItem('walleto.background-job', JSON.stringify({ id, token }));
  if (savedWallets) w.localStorage.setItem('walleto.wallets', JSON.stringify(savedWallets));
  w.AbortSignal = global.AbortSignal; w.TextDecoder = global.TextDecoder;
  w.FileReader = class { constructor() { throw new Error('Browser must not read the file'); } };
  w.scanDirect = () => { directCalls++; throw new Error('File results must not scan in the browser'); };
  w.confirm = message => { confirmations.push(message); return true; };
  w.URL.createObjectURL = blob => { blobs.push(blob); return `blob:http://127.0.0.1/${blobs.length}`; };
  w.URL.revokeObjectURL = value => revoked.push(value);
  w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  w.XMLHttpRequest = class {
    constructor() { this.upload = {}; xhrs.push(this); }
    open(method, resource) { this.method = method; this.resource = resource; }
    setRequestHeader(name, value) { this.header = [name, value]; }
    send(file) { this.file = file; }
    finish(status = 202, body = { id, token }) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  };
  w.fetch = async (resource, options = {}) => {
    const target = String(resource); requests.push({ url: target, options });
    if (target.startsWith('/api/scan')) return watchFetch ? watchFetch(target, options) : { ok: true, json: async () => ({ assets: [{ ...native, rawBalance: '0' }] }) };
    const requestedId = target.match(/\/jobs\/([a-f0-9]{64})/)?.[1];
    assert.equal(options.headers.Authorization, `Bearer ${requestedId === id2 ? token2 : token}`);
    if (target.includes('/dashboard')) {
      const params = new URL(target, url).searchParams;
      if (dashboardHook) await dashboardHook(params);
      const filter = params.get('network'); const assetOffset = Number(params.get('assetOffset')); const walletOffset = Number(params.get('walletOffset'));
      const filtered = filter === 'all' ? allAssets : allAssets.filter(row => row.network === filter);
      return { ok: true, json: async () => ({
        id: requestedId, status: 'finished', wallets: allWallets.length, total: allWallets.length * 5, completed: allWallets.length * 5,
        invalid: 0, incomplete: currentIncomplete, phraseMatching: true, retainsPhrases: true,
        knownValue: allAssets.length * 2, unpriced: 0, assetCount: allAssets.length, filteredAssetCount: filtered.length,
        assetOffset, walletOffset, network: filter, assets: filtered.slice(assetOffset, assetOffset + 100), walletPage: allWallets.slice(walletOffset, walletOffset + 100),
      }) };
    }
    if (target.includes('/phrase')) {
      const requested = new URL(target, url).searchParams.get('address');
      return { ok: true, json: async () => ({ phrase: getPhrase ? await getPhrase(requested) : requested === address2 ? phrase2 : phrase }) };
    }
    if (target.endsWith('/retry')) { currentIncomplete = 0; return { ok: true, json: async () => ({ ok: true }) }; }
    if (options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
    throw new Error(`Unexpected request: ${target}`);
  };
  w.eval(bundle);
  const derive = w.deriveWatchAddresses;
  w.deriveWatchAddresses = (...args) => { deriveCalls++; return derive(...args); };
  w.eval(background); w.eval(app);
  function selectFile(file) {
    Object.defineProperty($('seed-file'), 'files', { configurable: true, value: [file] });
    $('seed-file').dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  return { dom, w, $, requests, xhrs, blobs, downloads, confirmations, revoked, selectFile, deriveCalls: () => deriveCalls, directCalls: () => directCalls };
}

test('file selection on a public site is blocked without any local parsing or scanning', () => {
  const ctx = setup({ url: 'https://wallet.example/' }); const { dom, w, $, requests, xhrs } = ctx;
  const file = new w.File([phrase], 'sensitive.txt');
  ctx.selectFile(file);
  assert.match($('import-status').textContent, /private SSH tunnel/i);
  assert.equal(xhrs.length, 0); assert.equal(requests.length, 0); assert.equal(ctx.deriveCalls(), 0);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  assert.equal(w.document.getElementById('background-start'), null);
  assert.equal(w.document.getElementById('background-panel'), null);
  dom.window.close();
});

test('selecting a file uploads it directly, shows progress in the main dashboard, and never scans it locally', async () => {
  const ctx = setup(); const { dom, w, $, xhrs, requests, confirmations } = ctx;
  const file = new w.File([phrase], 'sensitive.txt');
  file.slice = () => { throw new Error('must not read file'); };
  file.text = () => { throw new Error('must not read file'); };
  $('seed-phrases').value = 'leave pasted text alone';
  ctx.selectFile(file);
  assert.equal(xhrs.length, 1); assert.equal(xhrs[0].file, file);
  assert.equal(xhrs[0].method, 'POST'); assert.equal(xhrs[0].resource, '/api/background/jobs');
  assert.deepEqual(xhrs[0].header, ['Content-Type', 'application/octet-stream']);
  assert.match(confirmations[0], /recovery phrases.*EC2/i);
  assert.match(confirmations[0], /laptop on until the upload is confirmed/i);
  assert.equal($('portfolio-source').value, 'file:new');
  assert.match($('progress-text').textContent, /Uploading file to EC2/i);
  assert.match($('progress-detail').textContent, /Keep this laptop on/i);
  xhrs[0].upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
  assert.match($('progress-text').textContent, /Uploading/i, '100% sent is not an acknowledgment');
  assert.match($('progress-detail').textContent, /until the upload is confirmed/i);
  assert.equal(w.localStorage.getItem('walleto.background-jobs'), null);
  xhrs[0].finish();
  await until(() => $('asset-list').querySelector('.asset-open'));
  assert.match($('import-status').textContent, /Upload confirmed.*laptop is off/i);
  assert.match($('progress-text').textContent, /Server scan complete/i);
  assert.equal($('wallet-count').textContent, '1'); assert.equal($('asset-count').textContent, '1');
  assert.equal($('total-value').textContent, '$2.00'); assert.match($('wallet-list').textContent, new RegExp(address));
  assert.match($('asset-list').textContent, /Ether/);
  assert.equal($('seed-phrases').value, 'leave pasted text alone');
  assert.equal(ctx.deriveCalls(), 0); assert.equal(ctx.directCalls(), 0);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.background-jobs')), [{ id, token }]);
  assert.ok(requests.every(item => item.url.includes('/dashboard')));
  assert.ok(!JSON.stringify(requests).includes(phrase));
  dom.window.close();
});

test('declined or unavailable uploads never fall back to browser processing', async () => {
  const ctx = setup(); const { dom, w, $, xhrs, requests } = ctx;
  const file = new w.File([phrase], 'wallets.txt');
  w.confirm = () => false; ctx.selectFile(file);
  assert.equal(xhrs.length, 0); assert.match($('import-status').textContent, /cancelled/i);
  w.confirm = () => true; ctx.selectFile(file);
  xhrs[0].finish(403, { error: 'worker disabled' });
  await wait();
  assert.match($('import-status').textContent, /not confirmed/i);
  assert.equal(ctx.deriveCalls(), 0); assert.equal(ctx.directCalls(), 0);
  assert.equal(requests.length, 0); assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  dom.window.close();
});

test('the main dashboard paginates and filters server results without importing addresses into local storage', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ address, network: 'ethereum', status: 'done', asset: { ...native, name: `Token ${index}` } }));
  rows.push({ address: address2, network: 'base', status: 'done', asset: { ...native, name: 'Second wallet' } });
  const wallets = Array.from({ length: 102 }, (_, i) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, total: 5, completed: 5, incomplete: 0, hasAssets: i === 101 }));
  const ctx = setup({ savedJob: true, assets: rows, wallets }); const { dom, w, $, requests } = ctx;
  await until(() => $('asset-list').querySelectorAll('.asset-open').length === 100);
  assert.equal($('asset-count').textContent, '101'); assert.equal($('wallet-count').textContent, '102');
  assert.equal($('asset-pager').hidden, false); assert.equal($('wallet-pager').hidden, false);
  assert.equal($('wallet-list').querySelectorAll('.wallet-row').length, 100);
  $('asset-next').click(); await until(() => $('asset-list').textContent.includes('Second wallet'));
  assert.equal($('asset-page-label').textContent, '101–101 of 101');
  $('asset-list').querySelector('.asset-open').click();
  assert.equal($('asset-export-address').textContent, address2);
  assert.doesNotMatch($('asset-export-dialog').textContent, /test test test/);
  $('asset-export-close').click();
  $('wallet-next').click(); await until(() => $('wallet-page-label').textContent === '101–102 of 102' && $('wallet-list').querySelectorAll('.wallet-row').length === 2);
  $('network-filter').value = 'base'; $('network-filter').dispatchEvent(new w.Event('change'));
  await until(() => $('asset-list').textContent.includes('Second wallet') && $('asset-badge').textContent === '1');
  assert.equal($('asset-count').textContent, '101', 'global asset count remains independent of filter');
  assert.equal(w.localStorage.getItem('walleto.wallets'), null); assert.equal(ctx.deriveCalls(), 0); assert.equal(ctx.directCalls(), 0);
  assert.ok(requests.every(item => !item.url.startsWith('/api/scan')));
  dom.window.close();
});

test('file asset export fetches the selected phrase only after confirmation and clears it on leaving', async () => {
  const ctx = setup({ savedJob: true }); const { dom, w, $, requests, blobs, confirmations, revoked } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  $('asset-list').querySelector('.asset-open').click();
  assert.equal($('asset-export-address').textContent, address);
  assert.match($('asset-export-note').textContent, /retrieved.*only when/i);
  assert.ok(requests.every(item => !item.url.includes('/phrase')));
  w.confirm = message => { confirmations.push(message); return false; };
  $('asset-export-download').click();
  assert.equal(blobs.length, 0); assert.ok(requests.every(item => !item.url.includes('/phrase')));
  assert.match(confirmations[0], /unencrypted recovery phrase/i);
  w.confirm = () => true;
  $('asset-export-download').click();
  await until(() => blobs.length === 1);
  assert.equal(await blobs[0].text(), `Wallet address: ${address}\nRecovery phrase: ${phrase}\n`);
  assert.doesNotMatch($('asset-export-dialog').textContent, /abandon abandon/);
  $('asset-export-reveal').click();
  await until(() => $('asset-export-phrase').textContent === phrase);
  $('asset-export-reveal').click();
  assert.doesNotMatch($('asset-export-dialog').textContent, /abandon abandon/);
  $('asset-export-reveal').click(); await until(() => $('asset-export-phrase').textContent === phrase);
  w.dispatchEvent(new w.Event('pagehide'));
  assert.equal($('asset-export-dialog').open, false); assert.equal($('asset-export-phrase').textContent, '');
  assert.ok(revoked.includes('blob:http://127.0.0.1/1'));
  dom.window.close();
});

test('a late server phrase response cannot reveal or download after the page is left', async () => {
  let finish;
  const ctx = setup({ savedJob: true, getPhrase: () => new Promise(resolve => { finish = resolve; }) });
  const { dom, w, $, blobs } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  $('asset-list').querySelector('.asset-open').click(); $('asset-export-download').click();
  await until(() => typeof finish === 'function');
  w.dispatchEvent(new w.Event('pagehide')); finish(phrase); await wait();
  assert.equal(blobs.length, 0); assert.equal($('asset-export-dialog').open, false);
  dom.window.close();
});

test('retry and deletion operate on the server job in the normal progress section', async () => {
  const ctx = setup({ savedJob: true, incomplete: 1 }); const { dom, $, requests, w } = ctx;
  await until(() => !$('retry-failed').hidden);
  $('retry-failed').click();
  await until(() => requests.some(item => item.url.endsWith('/retry')) && $('retry-failed').hidden);
  assert.equal($('file-remove').hidden, false);
  $('file-remove').click();
  await until(() => JSON.parse(w.localStorage.getItem('walleto.background-jobs')).length === 0);
  assert.equal($('portfolio-source').value, 'watch');
  assert.ok(requests.some(item => item.options.method === 'DELETE'));
  dom.window.close();
});

test('local watch addresses stay separate and file selection does not rescan them', async () => {
  const ctx = setup({ savedWallets: [{ address: address2, source: 'public' }] }); const { dom, $, requests, w, xhrs } = ctx;
  await until(() => requests.filter(item => item.url.startsWith('/api/scan')).length === 5 && !$('refresh').disabled);
  ctx.selectFile(new w.File([phrase], 'wallets.txt')); xhrs[0].finish();
  await until(() => $('asset-list').querySelector('.asset-open'));
  assert.equal(requests.filter(item => item.url.startsWith('/api/scan')).length, 5);
  assert.equal($('wallet-count').textContent, '1'); assert.match($('wallet-list').textContent, new RegExp(address));
  $('portfolio-source').value = 'watch'; $('portfolio-source').dispatchEvent(new w.Event('change'));
  assert.match($('wallet-list').textContent, new RegExp(address2));
  assert.doesNotMatch($('wallet-list').textContent, new RegExp(address));
  assert.equal(requests.filter(item => item.url.startsWith('/api/scan')).length, 5);
  dom.window.close();
});

test('an older paginated response cannot replace a newer network filter', async () => {
  let releaseBase;
  const assets = [
    { address, network: 'base', status: 'done', asset: { ...native, name: 'Base asset' } },
    { address, network: 'ethereum', status: 'done', asset: { ...native, name: 'Ethereum asset' } },
  ];
  const ctx = setup({ savedJob: true, assets, dashboardHook: params => params.get('network') === 'base' ? new Promise(resolve => { releaseBase = resolve; }) : undefined });
  const { dom, w, $ } = ctx;
  await until(() => $('asset-list').textContent.includes('Base asset'));
  $('network-filter').value = 'base'; $('network-filter').dispatchEvent(new w.Event('change'));
  await until(() => typeof releaseBase === 'function');
  $('network-filter').value = 'ethereum'; $('network-filter').dispatchEvent(new w.Event('change'));
  await until(() => $('asset-list').textContent.includes('Ethereum asset') && !$('asset-list').textContent.includes('Base asset'));
  releaseBase(); await wait();
  assert.match($('asset-list').textContent, /Ethereum asset/); assert.doesNotMatch($('asset-list').textContent, /Base asset/);
  dom.window.close();
});


test('multiple uploaded files are linked as separate server jobs and remain individually selectable', async () => {
  const ctx = setup(); const { dom, w, $, xhrs, requests } = ctx;
  ctx.selectFile(new w.File([phrase], 'first.txt')); xhrs[0].finish();
  await until(() => $('asset-list').querySelector('.asset-open'));
  assert.equal($('portfolio-source').value, `file:${id}`);
  ctx.selectFile(new w.File([phrase2], 'second.txt'));
  assert.equal(xhrs.length, 2); assert.equal($('portfolio-source').value, 'file:new');
  assert.equal($('portfolio-source').querySelector(`option[value="file:${id}"]`).disabled, true);
  xhrs[1].finish(202, { id: id2, token: token2 });
  await until(() => $('portfolio-source').value === `file:${id2}` && $('asset-list').querySelector('.asset-open'));
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.background-jobs')), [{ id, token }, { id: id2, token: token2 }]);
  assert.equal($('portfolio-source').options.length, 3);
  $('portfolio-source').value = `file:${id}`; $('portfolio-source').dispatchEvent(new w.Event('change'));
  await until(() => requests.filter(item => item.url.includes(`/jobs/${id}/dashboard`)).length === 2 && $('asset-list').querySelector('.asset-open'));
  assert.equal($('portfolio-source').value, `file:${id}`);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null); assert.equal(ctx.deriveCalls(), 0);
  assert.ok(requests.every(item => !item.url.startsWith('/api/scan')));
  dom.window.close();
});

test('reopening a file job does not automatically scan existing watch-list entries in the browser', async () => {
  const ctx = setup({ savedJob: true, savedWallets: [{ address: address2, source: 'seed' }] });
  const { dom, w, $, requests } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  assert.ok(requests.every(item => !item.url.startsWith('/api/scan')));
  $('portfolio-source').value = 'watch'; $('portfolio-source').dispatchEvent(new w.Event('change'));
  await until(() => requests.filter(item => item.url.startsWith('/api/scan')).length === 5);
  assert.match($('wallet-list').textContent, new RegExp(address2));
  dom.window.close();
});


test('starting a file job cancels an active foreground scan instead of running it alongside the upload', async () => {
  let cancelled = 0; let calls = 0;
  const ctx = setup({ savedWallets: [{ address: address2, source: 'seed' }], watchFetch: (_url, options) => {
    calls++;
    if (calls > 5) return Promise.resolve({ ok: true, json: async () => ({ assets: [{ ...native, rawBalance: '0' }] }) });
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { cancelled++; reject(new Error('aborted')); }, { once: true }));
  } });
  const { dom, w, $, xhrs } = ctx;
  await until(() => calls === 5);
  ctx.selectFile(new w.File([phrase], 'wallets.txt')); xhrs[0].finish();
  await until(() => cancelled === 5 && $('asset-list').querySelector('.asset-open'));
  assert.equal(calls, 5); assert.equal(ctx.directCalls(), 0);
  $('portfolio-source').value = 'watch'; $('portfolio-source').dispatchEvent(new w.Event('change'));
  await until(() => calls === 10 && !$('refresh').disabled);
  dom.window.close();
});

test('a late phrase reveal is suppressed after the tab becomes hidden', async () => {
  let finish;
  const ctx = setup({ savedJob: true, getPhrase: () => new Promise(resolve => { finish = resolve; }) });
  const { dom, w, $ } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  $('asset-list').querySelector('.asset-open').click(); $('asset-export-reveal').click();
  await until(() => typeof finish === 'function');
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.document.dispatchEvent(new w.Event('visibilitychange')); finish(phrase); await wait();
  assert.doesNotMatch($('asset-export-dialog').textContent, /abandon abandon/);
  assert.equal($('asset-export-reveal').getAttribute('aria-expanded'), 'false');
  dom.window.close();
});

test('a pending server export does not download after the tab becomes hidden', async () => {
  let finish;
  const ctx = setup({ savedJob: true, getPhrase: () => new Promise(resolve => { finish = resolve; }) });
  const { dom, w, $, blobs } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  $('asset-list').querySelector('.asset-open').click(); $('asset-export-download').click();
  await until(() => typeof finish === 'function');
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.document.dispatchEvent(new w.Event('visibilitychange')); finish(phrase); await wait();
  assert.equal(blobs.length, 0);
  dom.window.close();
});

test('a legacy stored server job is migrated without exposing its token in the selector', async () => {
  const ctx = setup({ savedJob: true }); const { dom, w, $ } = ctx;
  await until(() => $('asset-list').querySelector('.asset-open'));
  assert.equal(w.localStorage.getItem('walleto.background-job'), null);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.background-jobs')), [{ id, token }]);
  assert.equal($('portfolio-source').value, `file:${id}`);
  assert.doesNotMatch($('portfolio-source').outerHTML, new RegExp(token));
  dom.window.close();
});
