'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { Wallet } = require('ethers');
const { createBackgroundJobs } = require('../lib/background-jobs');
const { addressKeyRows, limitAddressKeyFileBytes, AddressKeyFileError } = require('../lib/address-key-file');
const { BUSD_BSC } = require('../lib/prices');

// Public test keys only. Never use these accounts for funds.
const key1 = `0x${'0'.repeat(63)}1`;
const key2 = `0x${'0'.repeat(63)}2`;
const address1 = new Wallet(key1).address;
const address2 = new Wallet(key2).address;
const wait = () => new Promise(resolve => setTimeout(resolve, 15));
function chunks(buffer, size = 7) {
  const parts = [];
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size));
  return Readable.from(parts);
}
function scanResult(address, network) {
  return { address, network, assets: [
    { type: 'native', name: 'Native', symbol: network === 'bitcoin' ? 'BTC' : 'ETH', rawBalance: '0', decimals: 18, price: null },
    ...(network === 'bnb' ? [{ type: 'BEP-20', name: 'BUSD', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '0', decimals: 18, price: null }] : []),
  ], ...(network === 'bnb' ? { coverage: 'bnb-and-busd' } : {}) };
}
async function finished(jobs, link) {
  for (let i = 0; i < 600; i++) {
    const status = jobs.status(link.id, link.token);
    if (status && ['finished', 'failed'].includes(status.status)) return status;
    await wait();
  }
  throw new Error('Timed out waiting for address/key job');
}

test('streams tab-separated address/private-key rows across chunks and recognizes a header', async () => {
  const text = `\ufeffaddress\tprivate key\r\n${address1}\t${key1}\r\n${address2}\t${key2}`;
  const rows = [];
  for await (const row of addressKeyRows(chunks(Buffer.from(text), 3))) rows.push(row);
  assert.deepEqual(rows, [
    { header: true, lineNumber: 1 },
    { address: address1, privateKey: key1, lineNumber: 2 },
    { address: address2, privateKey: key2, lineNumber: 3 },
  ]);
});

test('EC2 verifies pairs, ignores mismatches and persists only the unique public addresses', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-address-keys-'));
  const scans = [];
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => { scans.push([address, network]); return scanResult(address, network); } });
  try {
    const wrongAddress = `0x${'f'.repeat(40)}`;
    const text = `address\tprivate_key\n${address1}\t${key1}\n${address1}\t${key1}\n${wrongAddress}\t${key2}\n${address2}\t${key2}\nmalformed\tnope\n`;
    const link = await jobs.receive(chunks(Buffer.from(text), 5), { kind: 'address-keys' });
    assert.equal(link.kind, 'addresses');
    const status = await finished(jobs, link);
    assert.equal(status.status, 'finished');
    assert.equal(status.kind, 'addresses');
    assert.equal(status.addressFormat, 'key-pairs');
    assert.equal(status.lines, 5);
    assert.equal(status.invalid, 2);
    assert.equal(status.wallets, 2);
    assert.equal(status.total, 10);
    assert.equal(status.completed, 10);
    assert.equal(status.incomplete, 0);
    assert.equal(status.phraseMatching, false);
    assert.equal(status.retainsPhrases, false);
    assert.equal(status.hasBnbChecks, true);
    assert.equal(new Set(scans.map(([address, network]) => `${address.toLowerCase()}:${network}`)).size, 10);
    assert.ok(scans.every(([address]) => [address1.toLowerCase(), address2.toLowerCase()].includes(address.toLowerCase())));
    assert.equal(jobs.phrase(link.id, link.token, address1), null);
    assert.equal(fs.existsSync(path.join(dir, `${link.id}.upload`)), false);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    try {
      const stored = db.prepare('SELECT kind, key, iv, tag, phrase_key, retain_phrases FROM jobs WHERE id = ?').get(link.id);
      assert.equal(stored.kind, 'address-keys');
      assert.equal(stored.key, null); assert.equal(stored.iv, null); assert.equal(stored.tag, null); assert.equal(stored.phrase_key, null);
      assert.equal(stored.retain_phrases, 0);
    } finally { db.close(); }
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a key-pair file with no valid matches fails without retaining its encrypted upload or partial addresses', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-address-keys-invalid-'));
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => scanResult(address, network) });
  try {
    const wrongAddress = `0x${'f'.repeat(40)}`;
    const link = await jobs.receive(Readable.from(`${wrongAddress}\t${key1}\nmalformed\tnot-a-key\n`), { kind: 'address-keys' });
    const status = await finished(jobs, link);
    assert.equal(status.status, 'failed'); assert.equal(status.kind, 'addresses');
    assert.equal(status.wallets, 0); assert.equal(status.total, 0); assert.equal(status.invalid, 2);
    assert.match(status.error, /No valid matching address\/private-key pairs/i);
    assert.equal(status.error.includes(key1), false);
    assert.equal(fs.existsSync(path.join(dir, `${link.id}.upload`)), false);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    try {
      const stored = db.prepare('SELECT key, iv, tag FROM jobs WHERE id = ?').get(link.id);
      assert.equal(stored.key, null); assert.equal(stored.iv, null); assert.equal(stored.tag, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM wallets WHERE job = ?').get(link.id).count, 0);
    } finally { db.close(); }
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('address/key upload byte limiter rejects oversized streams', async () => {
  const source = Readable.from([Buffer.from('12345'), Buffer.from('67890')]);
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await assert.rejects(pipeline(source, limitAddressKeyFileBytes(8), sink), error => error instanceof AddressKeyFileError && error.code === 'TOO_LARGE');
});
