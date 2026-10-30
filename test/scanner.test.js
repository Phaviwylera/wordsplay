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

test('rejects missing or malformed balances rather than treating them as zero', async () => {
  for (const bad of [null, undefined, '-1', 'oops']) {
    const fetcher = async (url) => ({ ok: true, json: async () => url.endsWith('/stats') ? {} : url.endsWith('/token-balances') ? [] : { coin_balance: bad } });
    await assert.rejects(scanWallet(address, 'ethereum', fetcher), /Invalid balance/);
  }
  const fetcher = async (url) => ({ ok: true, json: async () => url.endsWith('/stats') ? {} : url.endsWith('/token-balances') ? [{ value: null }] : { coin_balance: '0' } });
  await assert.rejects(scanWallet(address, 'ethereum', fetcher), /Invalid balance/);
  const { scanDirect } = require('../public/direct-scan');
  await assert.rejects(scanDirect(address, 'ethereum', fetcher), /Invalid balance/);
});

test('shares one price request per network between concurrent scans', async () => {
  let statsCalls = 0;
  const fetcher = async (url) => {
    if (url.endsWith('/stats')) { statsCalls++; await new Promise(resolve => setTimeout(resolve, 10)); }
    return { ok: true, json: async () => url.endsWith('/stats') ? { coin_price: '2000' } : url.endsWith('/token-balances') ? [] : { coin_balance: '0' } };
  };
  const [first, second] = await Promise.all([scanWallet(address, 'base', fetcher), scanWallet('0x2222222222222222222222222222222222222222', 'base', fetcher)]);
  assert.equal(statsCalls, 1);
  assert.equal(first.assets[0].price, '2000');
  assert.equal(second.assets[0].price, '2000');
});

test('browser fallback shares optional price requests between simultaneous scans', async () => {
  const { scanDirect } = require('../public/direct-scan');
  let statsCalls = 0;
  const fetcher = async url => {
    if (url.endsWith('/stats')) { statsCalls++; await new Promise(resolve => setTimeout(resolve, 10)); }
    return { ok: true, json: async () => url.endsWith('/stats') ? { coin_price: '2000' } : url.endsWith('/token-balances') ? [] : { coin_balance: '0' } };
  };
  const [first, second] = await Promise.all([scanDirect(address, 'base', fetcher), scanDirect('0x2222222222222222222222222222222222222222', 'base', fetcher)]);
  assert.equal(statsCalls, 1);
  assert.equal(first.assets[0].price, '2000');
  assert.equal(second.assets[0].price, '2000');
});

test('scan API preserves a rate-limit response for the client', async () => {
  const handler = require('../api/scan');
  const originalFetch = global.fetch;
  const originalError = console.error;
  const result = {};
  global.fetch = async () => ({ ok: false, status: 429 });
  console.error = () => {};
  try {
    const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
    await handler({ method: 'GET', query: { address, network: 'ethereum' } }, res);
    assert.equal(result.status, 429);
    assert.match(result.body.error, /rate limiting/i);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // Public BIP-350 test vector.
const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // Public token-contract address.
test('validates Bitcoin and TRON checksums, EVM format and network matching', async () => {
  for (const value of [btc, btc.toUpperCase(), '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', tron, address]) assert.equal(validAddress(value), true, value);
  for (const value of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', `${tron.slice(0, -1)}u`, 'a'.repeat(10000)]) assert.equal(validAddress(value), false, value.slice(0, 100));
  await assert.rejects(scanWallet(btc, 'ethereum'), /match network/);
  await assert.rejects(scanWallet(address, 'tron'), /match network/);
  await assert.rejects(scanWallet(tron, 'bnb'), /match network/);
});

test('scans Bitcoin confirmed and pending amounts with exact satoshis', async () => {
  const fetcher = async url => {
    assert.equal(url, `https://mempool.space/api/address/${btc}`);
    return { ok: true, json: async () => ({ chain_stats: { funded_txo_sum: 500000000, spent_txo_sum: 200000000 }, mempool_stats: { funded_txo_sum: 500, spent_txo_sum: 100 } }) };
  };
  const result = await scanWallet(btc, 'bitcoin', fetcher);
  assert.equal(result.assets[0].rawBalance, '300000400');
  assert.equal(result.assets[0].decimals, 8);
  assert.equal(result.assets[0].price, null);
  assert.equal(result.coverage, 'native-only');
  const { scanDirect } = require('../public/direct-scan');
  assert.equal((await scanDirect(btc, 'bitcoin', fetcher)).assets[0].rawBalance, '300000400');
  for (const bad of [{}, { chain_stats: { funded_txo_sum: 1, spent_txo_sum: 2 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }, { chain_stats: { funded_txo_sum: Number.MAX_SAFE_INTEGER + 1, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }]) {
    await assert.rejects(scanWallet(btc, 'bitcoin', async () => ({ ok: true, json: async () => bad })), /Invalid/);
  }
});

test('scans TRX and native BNB with strict responses', async () => {
  const tx = await scanWallet(tron, 'tron', async url => {
    assert.equal(url, `https://api.trongrid.io/v1/accounts/${tron}`);
    return { ok: true, json: async () => ({ success: true, data: [{ balance: 1234567 }] }) };
  });
  assert.equal(tx.assets[0].rawBalance, '1234567');
  assert.equal(tx.assets[0].decimals, 6);
  const bnb = await scanWallet(address, 'bnb', async (url, options) => {
    assert.equal(url, 'https://bsc-rpc.publicnode.com');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.method, 'eth_getBalance');
    assert.deepEqual(body.params, [address, 'latest']);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }) };
  });
  assert.equal(bnb.assets[0].rawBalance, '1000000000000000000');
  assert.equal(bnb.coverage, 'native-only');
  await assert.rejects(scanWallet(tron, 'tron', async () => ({ ok: true, json: async () => ({ success: true, data: [] }) })), /Incomplete/);
  await assert.rejects(scanWallet(tron, 'tron', async () => ({ ok: true, json: async () => ({ success: true, data: [{}] }) })), /Invalid/);
  await assert.rejects(scanWallet(address, 'bnb', async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: 'garbage' }) })), /Invalid/);
  await assert.rejects(scanWallet(address, 'bnb', async () => ({ ok: false, status: 429 })), /429/);
});

test('scan API rejects valid addresses submitted to the wrong network', async () => {
  const handler = require('../api/scan');
  const result = {};
  const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
  await handler({ method: 'GET', query: { address: btc, network: 'tron' } }, res);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /match network/);
});
