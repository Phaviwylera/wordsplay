const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { Wallet } = require('ethers');

// Public test phrases only. Never use these accounts for real funds.
const phrase1 = 'test test test test test test test test test test test junk';
const phrase2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const address1 = Wallet.fromPhrase(phrase1).address;
const address2 = Wallet.fromPhrase(phrase2).address;
const bitcoin = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const positive = { name: 'Ether', symbol: 'ETH', type: 'native', rawBalance: '1000000000000000000', decimals: 18, price: '2' };
const zero = { ...positive, rawBalance: '0', price: null };
const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const bundle = esbuild.buildSync({ entryPoints: ['src/derive.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, timeout = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('UI did not finish');
    await wait();
  }
}
function submit(w, form) { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
function setup({ saved, custody, response } = {}) {
  const dom = new JSDOM(html, { url: 'https://wallet.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.AbortSignal = global.AbortSignal;
  w.TextDecoder = global.TextDecoder;
  if (saved) w.localStorage.setItem('walleto.wallets', saved);
  if (custody) w.localStorage.setItem('walleto.encrypted-wallet.v1', custody);
  const requests = []; const blobs = []; const downloads = []; const confirmations = []; const revoked = [];
  w.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const params = new URL(url, 'https://wallet.example').searchParams;
    const network = params.get('network');
    let data = response ? response(params) : { assets: [network === 'ethereum' || network === 'base' ? positive : zero] };
    if (network === 'bnb' && data.coverage === undefined) data = { ...data, coverage: 'bnb-and-busd', assets: [...data.assets, { type: 'BEP-20', symbol: 'BUSD', contract: '0xe9e7cea3dedca5984780bafc599bd69add087d56', rawBalance: '0', decimals: 18, price: null }] };
    return { ok: true, json: async () => data };
  };
  w.URL.createObjectURL = blob => { blobs.push(blob); return `blob:https://wallet.example/${blobs.length}`; };
  w.URL.revokeObjectURL = url => { revoked.push(url); };
  w.HTMLAnchorElement.prototype.click = function () { downloads.push({ filename: this.download, href: this.href }); };
  w.confirm = message => { confirmations.push(message); return true; };
  w.eval(bundle); w.eval(app);
  const $ = id => w.document.getElementById(id);
  return { dom, w, $, requests, blobs, downloads, confirmations, revoked };
}
function assetButton(w, address, network = 'Ethereum') {
  return [...w.document.querySelectorAll('.asset-open')].find(button => button.getAttribute('aria-label').includes(address) && button.getAttribute('aria-label').includes(network));
}
async function seedImport(ctx, text) {
  ctx.$('seed-phrases').value = text;
  submit(ctx.w, ctx.$('seed-form'));
  await until(() => !ctx.$('seed-form').querySelector('button[type="submit"]').disabled && !ctx.$('refresh').disabled);
}
async function addressImport(ctx, address) {
  ctx.$('wallet-address').value = address;
  submit(ctx.w, ctx.$('address-form'));
  await until(() => !ctx.$('refresh').disabled);
}

test('exports only the selected seed wallet and keeps phrases hidden until requested', async () => {
  const ctx = setup(); const { dom, w, $, blobs, downloads, confirmations, requests } = ctx;
  await seedImport(ctx, `${phrase1}\n${phrase2}\ninvalid words`);
  assert.equal($('seed-phrases').value, '');
  assert.match($('import-status').textContent, /2 recovery phrases available for export/);
  assert.equal(w.localStorage.getItem('walleto.wallets').includes(phrase1), false);
  assert.equal(w.localStorage.getItem('walleto.wallets').includes(phrase2), false);
  assert.equal(w.sessionStorage.length, 0);
  assert.ok(requests.every(({ url, options }) => !`${url} ${options?.body || ''}`.includes(phrase1) && !`${url} ${options?.body || ''}`.includes(phrase2)));
  assert.ok(assetButton(w, address1));
  assert.equal(assetButton(w, address1).getAttribute('aria-haspopup'), 'dialog');

  // Clicking anywhere in the asset row opens that asset's wallet, not just its button.
  assetButton(w, address1).closest('tr').querySelector('td:last-child').click();
  assert.equal($('asset-export-dialog').open, true);
  assert.equal($('asset-export-address').textContent, address1);
  assert.equal($('asset-export-phrase-block').hidden, false);
  assert.doesNotMatch($('asset-export-dialog').textContent, /test test test/);
  $('asset-export-reveal').click();
  assert.equal($('asset-export-phrase').textContent, phrase1);
  assert.equal($('asset-export-reveal').getAttribute('aria-expanded'), 'true');
  $('asset-export-reveal').click();
  assert.doesNotMatch($('asset-export-dialog').textContent, /test test test/);

  w.confirm = message => { confirmations.push(message); return false; };
  $('asset-export-download').click();
  assert.equal(blobs.length, 0, 'declining the secret export does not create a file');
  assert.match(confirmations[0], /unencrypted recovery phrase/i);
  w.confirm = message => { confirmations.push(message); return true; };
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `Wallet address: ${address1}\nRecovery phrase: ${phrase1}\n`);
  assert.equal(downloads[0].filename, 'walleto-wallet.txt');
  $('asset-export-reveal').click();
  $('asset-export-close').click();
  assert.equal($('asset-export-dialog').open, false);
  assert.equal($('asset-export-phrase').textContent, '');

  // A different network of the same address and a different wallet map correctly.
  assetButton(w, address1, 'Base').click();
  $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `Wallet address: ${address1}\nRecovery phrase: ${phrase1}\n`);
  $('asset-export-cancel').click();
  assetButton(w, address2).click();
  $('asset-export-download').click();
  assert.equal(await blobs[2].text(), `Wallet address: ${address2}\nRecovery phrase: ${phrase2}\n`);
  assert.equal((await blobs[2].text()).includes(phrase1), false);
  dom.window.close();
});

test('a public address with an unpriced positive asset exports exactly the address', async () => {
  const ctx = setup({ response: params => {
    if (params.get('network') === 'bitcoin') return { coverage: 'native-only', assets: [{ name: 'Bitcoin', symbol: 'BTC', type: 'native', rawBalance: '1', decimals: 8, price: null }] };
    return { assets: [zero] };
  } });
  const { dom, w, $, blobs, confirmations } = ctx;
  await addressImport(ctx, bitcoin.toUpperCase());
  assert.match($('asset-list').textContent, /Price unavailable/);
  assert.match($('asset-list').textContent, /0\.00000001/);
  assetButton(w, bitcoin, 'Bitcoin').click();
  assert.equal($('asset-export-address').textContent, bitcoin);
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.match($('asset-export-download').textContent, /Export address only/);
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `${bitcoin}\n`);
  assert.equal(confirmations.length, 0);
  dom.window.close();
});

test('reloading forgets a seed phrase and re-importing relinks the existing wallet', async () => {
  const first = setup();
  await seedImport(first, phrase1);
  const saved = first.w.localStorage.getItem('walleto.wallets');
  assert.deepEqual(JSON.parse(saved), [{ address: address1, source: 'seed' }]);
  first.dom.window.close();

  const ctx = setup({ saved }); const { dom, w, $, blobs, revoked } = ctx;
  await until(() => !$('refresh').disabled && assetButton(w, address1));
  assetButton(w, address1).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.match($('asset-export-note').textContent, /not saved.*Re-import/i);
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `${address1}\n`);
  $('asset-export-close').click();

  await seedImport(ctx, phrase1);
  assert.match($('import-status').textContent, /1 duplicate skipped/);
  assert.match($('import-status').textContent, /1 recovery phrase available for export/);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets')).length, 1);
  assetButton(w, address1).click();
  $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `Wallet address: ${address1}\nRecovery phrase: ${phrase1}\n`);
  $('asset-export-reveal').click();
  w.dispatchEvent(new w.Event('pagehide'));
  assert.equal($('asset-export-dialog').open, false);
  assert.equal($('asset-export-phrase').textContent, '');
  assert.ok(revoked.includes('blob:https://wallet.example/2'), 'download URLs are revoked on pagehide');
  assetButton(w, address1).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.match($('asset-export-note').textContent, /Re-import/i);
  dom.window.close();
});

test('labeled pasted phrases link each validated phrase to its own address', async () => {
  const ctx = setup(); const { dom, w, $, blobs } = ctx;
  $('seed-phrases').value = `Second: ${phrase2}\r\n2. ${phrase1}\r\ninvalid\r\n${phrase2}`;
  submit(w, $('seed-form'));
  await until(() => !$('seed-form').querySelector('button[type="submit"]').disabled && !$('refresh').disabled);
  assert.match($('import-status').textContent, /1 duplicate skipped/);
  assert.match($('import-status').textContent, /invalid line 3/);
  assert.doesNotMatch(w.localStorage.getItem('walleto.wallets'), /abandon|test test/);
  assetButton(w, address1).click(); $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `Wallet address: ${address1}\nRecovery phrase: ${phrase1}\n`);
  $('asset-export-close').click();
  assetButton(w, address2).click(); $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `Wallet address: ${address2}\nRecovery phrase: ${phrase2}\n`);
  dom.window.close();
});

test('re-importing a seed upgrades a public entry, and removing it forgets the phrase', async () => {
  const ctx = setup(); const { dom, w, $, blobs } = ctx;
  await addressImport(ctx, address1.toLowerCase());
  assetButton(w, address1.toLowerCase()).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  $('asset-export-close').click();
  await seedImport(ctx, phrase1);
  assert.match($('import-status').textContent, /1 duplicate skipped/);
  assert.equal(JSON.parse(w.localStorage.getItem('walleto.wallets'))[0].source, 'seed');
  assetButton(w, address1.toLowerCase()).click();
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `Wallet address: ${address1.toLowerCase()}\nRecovery phrase: ${phrase1}\n`);
  $('asset-export-reveal').click();
  $('wallet-list').querySelector('.remove-wallet').click();
  assert.equal($('asset-export-dialog').open, false);
  assert.equal($('asset-export-phrase').textContent, '');
  await addressImport(ctx, address1);
  assetButton(w, address1).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `${address1}\n`);
  dom.window.close();
});

test('selecting assets after pagination and filtering preserves the wallet association', async () => {
  const ctx = setup({ response: params => {
    const address = params.get('address').toLowerCase();
    const network = params.get('network');
    if (network === 'ethereum' && address === address1.toLowerCase()) return { assets: [positive, ...Array.from({ length: 104 }, (_, index) => ({ ...positive, type: 'ERC-20', contract: `0x${index.toString(16).padStart(40, '0')}`, name: `Token ${index}` }))] };
    if ((network === 'ethereum' || network === 'base') && address === address2.toLowerCase()) return { assets: [positive] };
    return { assets: [zero] };
  } });
  const { dom, w, $, blobs } = ctx;
  await seedImport(ctx, `${phrase1}\n${phrase2}`);
  assert.equal($('asset-pager').hidden, false);
  $('asset-next').click();
  assert.ok(assetButton(w, address2));
  assetButton(w, address2).click(); $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `Wallet address: ${address2}\nRecovery phrase: ${phrase2}\n`);
  $('asset-export-close').click();
  $('network-filter').value = 'base';
  $('network-filter').dispatchEvent(new w.Event('change'));
  assert.equal($('asset-list').querySelectorAll('tr').length, 1);
  assetButton(w, address2, 'Base').click(); $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `Wallet address: ${address2}\nRecovery phrase: ${phrase2}\n`);
  dom.window.close();
});

test('leaving while an import is in progress prevents late phrase retention', async () => {
  const ctx = setup(); const { dom, w, $ } = ctx;
  let finish;
  w.deriveWatchAddresses = (text, progress, onPhrase) => new Promise((resolve, reject) => {
    finish = () => { try { onPhrase(address1, phrase1); resolve({ addresses: [address1], invalid: [], invalidCount: 0 }); } catch (error) { reject(error); } };
  });
  $('seed-phrases').value = phrase1;
  submit(w, $('seed-form'));
  assert.equal($('seed-form').querySelector('button[type="submit"]').disabled, true);
  w.dispatchEvent(new w.Event('pagehide'));
  finish();
  await until(() => !$('seed-form').querySelector('button[type="submit"]').disabled);
  assert.match($('import-status').textContent, /Import interrupted/);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  assert.equal($('asset-list').children.length, 0);
  dom.window.close();
});

test('untrusted asset names remain text in the row and export dialog', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const ctx = setup({ response: params => ({ assets: [params.get('network') === 'ethereum' ? { ...positive, name: hostile } : zero] }) });
  const { dom, w, $ } = ctx;
  await addressImport(ctx, address1);
  assert.equal($('asset-list').querySelector('img'), null);
  assetButton(w, address1).click();
  assert.equal($('asset-export-dialog').querySelector('img'), null);
  assert.ok($('asset-export-description').textContent.includes(hostile));
  dom.window.close();
});


test('generated phrases can be exported for a positive asset', async () => {
  const ctx = setup(); const { dom, w, $, blobs } = ctx;
  w.crypto.getRandomValues = bytes => { bytes.fill(0); return bytes; };
  $('generate-phrase').click();
  assert.equal($('seed-phrases').value, phrase2);
  submit(w, $('seed-form'));
  await until(() => !$('seed-form').querySelector('button[type="submit"]').disabled && !$('refresh').disabled);
  assetButton(w, address2).click();
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `Wallet address: ${address2}\nRecovery phrase: ${phrase2}\n`);
  dom.window.close();
});

test('removing all wallets forgets every retained phrase', async () => {
  const ctx = setup(); const { dom, w, $, blobs } = ctx;
  await seedImport(ctx, `${phrase1}\n${phrase2}`);
  $('remove-all').click();
  assert.equal($('wallet-count').textContent, '0');
  await addressImport(ctx, address1);
  await addressImport(ctx, address2);
  for (const address of [address1, address2]) {
    assetButton(w, address).click();
    assert.equal($('asset-export-phrase-block').hidden, true);
    $('asset-export-download').click();
    $('asset-export-close').click();
  }
  assert.equal(await blobs[0].text(), `${address1}\n`);
  assert.equal(await blobs[1].text(), `${address2}\n`);
  dom.window.close();
});

test('hides a revealed phrase when the tab becomes hidden and reports download failures', async () => {
  const ctx = setup(); const { dom, w, $ } = ctx;
  await seedImport(ctx, phrase1);
  assetButton(w, address1).click();
  $('asset-export-reveal').click();
  assert.equal($('asset-export-phrase').textContent, phrase1);
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.doesNotMatch($('asset-export-phrase').textContent, /test test/);
  assert.equal($('asset-export-reveal').getAttribute('aria-expanded'), 'false');
  w.URL.createObjectURL = () => { throw new Error('unavailable'); };
  $('asset-export-download').click();
  assert.match($('asset-export-status').textContent, /Could not start the export/);
  dom.window.close();
});

test('retrying a seed import does not hide an unsaved watch-list change', async () => {
  const ctx = setup(); const { dom, w, $ } = ctx;
  const setItem = w.Storage.prototype.setItem;
  let storageFails = true;
  w.Storage.prototype.setItem = function (key, value) {
    if (storageFails && key === 'walleto.wallets') throw new Error('quota exceeded');
    return setItem.call(this, key, value);
  };
  await seedImport(ctx, phrase1);
  assert.match($('import-status').textContent, /storage is full or unavailable/);
  assert.equal(w.localStorage.getItem('walleto.wallets'), null);
  await seedImport(ctx, phrase1);
  assert.match($('import-status').textContent, /storage is full or unavailable/);
  storageFails = false;
  await seedImport(ctx, phrase1);
  assert.doesNotMatch($('import-status').textContent, /storage is full or unavailable/);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('walleto.wallets')), [{ address: address1, source: 'seed' }]);
  dom.window.close();
});

test('a matching self-custody wallet stays address-only until explicitly unlocked', { timeout: 120000 }, async () => {
  const password = 'very-strong-test-password';
  const encrypted = await Wallet.fromPhrase(phrase1).encrypt(password);
  const ctx = setup({ saved: JSON.stringify([{ address: address1 }]), custody: encrypted });
  const { dom, w, $, blobs, confirmations, requests } = ctx;
  await until(() => !$('refresh').disabled && assetButton(w, address1));
  assetButton(w, address1).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.equal($('asset-export-unlock').hidden, false);
  $('asset-export-download').click();
  assert.equal(await blobs[0].text(), `${address1}\n`);
  assert.equal(confirmations.length, 0, 'address-only export does not unlock the wallet');

  $('asset-export-password').value = 'wrong-password';
  submit(w, $('asset-export-unlock'));
  assert.equal($('asset-export-password').value, '');
  await until(() => !$('asset-export-unlock-button').disabled, 60000);
  assert.match($('asset-export-unlock-status').textContent, /Could not unlock/);
  assert.equal($('asset-export-phrase-block').hidden, true);

  $('asset-export-password').value = password;
  submit(w, $('asset-export-unlock'));
  assert.equal($('asset-export-password').value, '');
  await until(() => !$('asset-export-unlock-button').disabled, 60000);
  assert.equal($('asset-export-phrase-block').hidden, false);
  assert.equal($('asset-export-unlock').hidden, true);
  assert.doesNotMatch($('asset-export-dialog').textContent, /test test test/);
  $('asset-export-download').click();
  assert.equal(await blobs[1].text(), `Wallet address: ${address1}\nRecovery phrase: ${phrase1}\n`);
  assert.match(confirmations[0], /unencrypted recovery phrase/i);
  assert.equal(w.localStorage.getItem('walleto.encrypted-wallet.v1').includes(phrase1), false);
  assert.equal(w.localStorage.getItem('walleto.wallets').includes(phrase1), false);
  assert.ok(requests.every(({ url, options }) => !`${url} ${options?.body || ''}`.includes(password) && !`${url} ${options?.body || ''}`.includes(phrase1)));
  w.dispatchEvent(new w.Event('pagehide'));
  assetButton(w, address1).click();
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.equal($('asset-export-unlock').hidden, false, 'a later session needs the password again');
  dom.window.close();
});

test('a different or malformed self-custody keystore cannot unlock a public address', async () => {
  for (const custody of [JSON.stringify({ address: address2.slice(2) }), '{invalid']) {
    const ctx = setup({ saved: JSON.stringify([{ address: address1 }]), custody });
    const { dom, w, $ } = ctx;
    await until(() => !$('refresh').disabled && assetButton(w, address1));
    assetButton(w, address1).click();
    assert.equal($('asset-export-unlock').hidden, true);
    assert.equal($('asset-export-phrase-block').hidden, true);
    dom.window.close();
  }
});

test('closing or removing a keystore while unlocking cannot retain a late phrase', async () => {
  const custody = JSON.stringify({ address: address1.slice(2) });
  const ctx = setup({ saved: JSON.stringify([{ address: address1 }]), custody });
  const { dom, w, $ } = ctx;
  await until(() => !$('refresh').disabled && assetButton(w, address1));
  let finish;
  w.unlockCustodyRecoveryPhrase = () => new Promise(resolve => { finish = resolve; });
  assetButton(w, address1).click();
  $('asset-export-password').value = 'password'; submit(w, $('asset-export-unlock'));
  assert.equal($('asset-export-unlock-button').disabled, true);
  $('asset-export-close').click();
  assetButton(w, address1).click();
  finish({ address: address1, phrase: phrase1 });
  await wait();
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.equal($('asset-export-unlock').hidden, false);

  $('asset-export-password').value = 'password'; submit(w, $('asset-export-unlock'));
  w.localStorage.removeItem('walleto.encrypted-wallet.v1');
  finish({ address: address1, phrase: phrase1 });
  await until(() => !$('asset-export-unlock-button').disabled);
  assert.equal($('asset-export-phrase-block').hidden, true);
  assert.match($('asset-export-unlock-status').textContent, /Could not unlock/);
  dom.window.close();
});
