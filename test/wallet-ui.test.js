const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');

// A public test mnemonic only. Never use it for real assets.
const phrase = 'test test test test test test test test test test test junk';
const address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 60000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeout) throw new Error('UI did not finish'); await delay(30); }
}

test('imports, encrypts, locks and unlocks a wallet without storing its phrase', { timeout: 120000 }, async () => {
  const bundle = esbuild.buildSync({ entryPoints: ['src/wallet.js'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text;
  const dom = new JSDOM(fs.readFileSync('public/wallet.html', 'utf8'), { url: 'https://wallet.example/wallet', runScripts: 'outside-only' });
  const { window } = dom;
  window.eval(bundle);
  const $ = id => window.document.getElementById(id);
  $('show-import').click();
  $('phrase').value = phrase;
  $('new-password').value = 'very-strong-test-password';
  $('confirm-password').value = 'very-strong-test-password';
  $('save-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('unlocked').hidden);
  assert.equal($('address').textContent, address);
  const saved = window.localStorage.getItem('walleto.encrypted-wallet.v1');
  assert.ok(saved);
  assert.equal(saved.includes(phrase), false);
  assert.equal($('phrase').value, '');
  $('track-address').click();
  assert.equal(JSON.parse(window.localStorage.getItem('walleto.wallets'))[0].address, address);
  $('lock-wallet').click();
  assert.equal($('locked').hidden, false);
  $('unlock-password').value = 'very-strong-test-password';
  $('unlock-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('unlocked').hidden);
  assert.equal($('address').textContent, address);
  dom.window.close();
});

test('signs an offline native transfer with the expected chain, recipient and value', async () => {
  const { Wallet, Transaction, parseEther } = require('ethers');
  const wallet = Wallet.fromPhrase(phrase);
  const signed = await wallet.signTransaction({ chainId: 1, type: 2, nonce: 0, to: '0x0000000000000000000000000000000000000001', value: parseEther('0.001'), gasLimit: 21000, maxFeePerGas: 1000000000, maxPriorityFeePerGas: 100000000 });
  const tx = Transaction.from(signed);
  assert.equal(tx.from, address);
  assert.equal(tx.chainId, 1n);
  assert.equal(tx.to, '0x0000000000000000000000000000000000000001');
  assert.equal(tx.value, parseEther('0.001'));
});
