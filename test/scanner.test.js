const test = require('node:test');
const assert = require('node:assert/strict');
const { scanWallet, validAddress } = require('../lib/scanner');
const address = '0x1234567890123456789012345678901234567890';

test('validates public EVM addresses', () => {
  assert.equal(validAddress(address), true);
  assert.equal(validAddress('secret recovery phrase'), false);
  assert.equal(validAddress('0x123'), false);
});
test('returns native and discovered token balances', async () => {
  const fetcher = async (url) => ({ ok: true, json: async () => url.endsWith('/stats') ? { coin_price: '2000' } : url.endsWith('/token-balances') ? [
    { value: '1500000', token: { name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20', exchange_rate: '1', address_hash: address } },
    { value: '0', token: { name: 'Empty' } },
    { value: '1', token_id: '42', token: { name: 'Collectible', type: 'ERC-721', decimals: null } },
  ] : { coin_balance: '1000000000000000000' } });
  const result = await scanWallet(address, 'base', fetcher);
  assert.equal(result.assets.length, 3);
  assert.equal(result.assets[0].price, '2000');
  assert.equal(result.assets[1].decimals, 6);
  assert.equal(result.assets[2].tokenId, '42');
});
test('keeps balances when optional pricing is unavailable', async () => {
  const fetcher = async (url) => url.endsWith('/stats') ? { ok: false, status: 503 } : { ok: true, json: async () => url.endsWith('/token-balances') ? [] : { coin_balance: '1' } };
  const result = await scanWallet(address, 'ethereum', fetcher);
  assert.equal(result.assets[0].price, null);
});
test('rejects unsupported networks and failed indexers', async () => {
  await assert.rejects(scanWallet(address, 'unknown'), /Unsupported/);
  await assert.rejects(scanWallet(address, 'base', async () => ({ ok: false, status: 503 })), /503/);
});

test('browser fallback reads public indexer balances and tolerates unavailable prices', async () => {
  const { scanDirect } = require('../public/direct-scan');
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    if (url.endsWith('/stats')) throw new Error('unavailable');
    return { ok: true, json: async () => url.endsWith('/token-balances') ? [] : { coin_balance: '250000000000000000' } };
  };
  const result = await scanDirect(address, 'ethereum', fetcher);
  assert.equal(result.assets[0].rawBalance, '250000000000000000');
  assert.equal(result.assets[0].price, null);
  assert.ok(urls.every(url => url.startsWith('https://eth.blockscout.com/')));
});
test('browser fallback reports a failed indexer rather than a zero balance', async () => {
  const { scanDirect } = require('../public/direct-scan');
  await assert.rejects(scanDirect(address, 'ethereum', async () => ({ ok: false, status: 503 })), /503/);
});
