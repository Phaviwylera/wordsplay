'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createBackgroundJobs } = require('../lib/background-jobs');
const { limitAddressCsvBytes } = require('../lib/address-csv');
const { BUSD_BSC } = require('../lib/prices');

// Public test addresses. Never use these as accounts for funds.
const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const evm1 = `0x${'1'.repeat(40)}`;
const evm2 = `0x${'2'.repeat(40)}`;
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
const zeroBusd = { type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '0', decimals: 18, price: null };
function result(address, network, balance = '0') {
  const asset = { type: 'native', name: 'Native', symbol: network === 'bitcoin' ? 'BTC' : 'ETH', rawBalance: balance, decimals: 18, price: null };
  return { address, network, assets: [asset, ...(network === 'bnb' ? [zeroBusd] : [])], ...(network === 'bnb' ? { coverage: 'bnb-and-busd' } : {}) };
}
async function finished(jobs, link) {
  for (let i = 0; i < 600; i++) {
    const status = jobs.status(link.id, link.token);
    if (status && ['finished', 'failed'].includes(status.status)) return status;
    await wait();
  }
  throw new Error('Timed out waiting for CSV job');
}
function chunks(buffer, size) {
  const parts = [];
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size));
  return Readable.from(parts);
}

test('CSV imports Bitcoin and EVM columns, deduplicates, and ignores other fields', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-address-csv-'));
  const seen = []; const secretMarker = 'NEVER_SAVE_THIS_SECRET_MARKER';
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => { seen.push([address, network]); return result(address, network, '1'); } });
  try {
    const csv = '\ufeffphrase_line,btc_native_segwit,ethereum,bnb_smart_chain,base,status,private_key\r\n'
      + `1,"${btc}",${evm1},${evm1.toUpperCase().replace('0X', '0x')},${evm1},"ok, नमस्ते","${secretMarker}"\r\n`
      + `2,${btc.toUpperCase()},${evm2},${evm2},${evm2},"quoted ""note""\nline",ignored\r\n`
      + '3,invalid-bitcoin,not-an-address,,,ok,ignored\r\n';
    const link = await jobs.receive(chunks(Buffer.from(csv), 7), { kind: 'addresses' });
    assert.equal(link.kind, 'addresses'); assert.equal(jobs.status(link.id, '0'.repeat(64)), null);
    const status = await finished(jobs, link);
    assert.equal(status.status, 'finished'); assert.equal(status.kind, 'addresses');
    assert.equal(status.lines, 3); assert.equal(status.invalid, 2);
    assert.equal(status.wallets, 3); assert.equal(status.total, 11); assert.equal(status.completed, 11); assert.equal(status.incomplete, 0);
    assert.equal(status.phraseMatching, false); assert.equal(status.retainsPhrases, false); assert.equal(status.hasBnbChecks, true);
    const checks = jobs.results(link.id, link.token).checks;
    assert.equal(checks.filter(row => row.network === 'bitcoin').length, 1);
    assert.equal(checks.filter(row => row.network !== 'bitcoin').length, 10);
    assert.equal(seen.length, 11); assert.equal(new Set(seen.map(([address, network]) => `${address}:${network}`)).size, 11);
    assert.equal(jobs.dashboard(link.id, link.token).assetCount, 11);
    assert.equal(jobs.phrase(link.id, link.token, evm1), null);
    assert.equal(jobs.matches(link.id, link.token).enabled, false);
    assert.equal(fs.existsSync(path.join(dir, `${link.id}.upload`)), false);
    for (const file of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, file)).includes(Buffer.from(secretMarker)), false);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Bitcoin zero and incomplete checks remain accurate across retry and BNB refresh', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-address-zero-'));
  let failBitcoin = true; let blockBnb = false; let releaseBnb;
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => {
    if (failBitcoin && network === 'bitcoin') throw new Error('provider offline');
    if (blockBnb && network === 'bnb') await new Promise(resolve => { releaseBnb = resolve; });
    return result(address, network);
  } });
  try {
    const link = await jobs.receive(Readable.from(`bitcoin,ethereum\n${btc},${evm1}\n`), { kind: 'addresses' });
    let status = await finished(jobs, link);
    assert.equal(status.incomplete, 1); assert.equal(status.hiddenWallets, 1); assert.equal(status.visibleWallets, 1);
    assert.equal(jobs.dashboard(link.id, link.token).walletPage[0].address, btc);
    failBitcoin = false; assert.equal(jobs.retry(link.id, link.token), true);
    status = await finished(jobs, link);
    assert.equal(status.incomplete, 0); assert.equal(status.hiddenWallets, 2);
    blockBnb = true; assert.equal(jobs.refreshBnb(link.id, link.token), true);
    for (let i = 0; i < 200 && !releaseBnb; i++) await wait();
    assert.equal(typeof releaseBnb, 'function');
    status = jobs.status(link.id, link.token);
    assert.equal(status.status, 'scanning'); assert.equal(status.hiddenWallets, 1, 'the Bitcoin wallet is not unhidden by a BNB-only refresh');
    releaseBnb(); blockBnb = false;
    status = await finished(jobs, link);
    assert.equal(status.hiddenWallets, 2); assert.equal(status.completed, 6);
    assert.equal(jobs.restoreHidden(link.id, link.token), 2);
    assert.equal(jobs.dashboard(link.id, link.token).walletPage.length, 2);
  } finally { releaseBnb?.(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Bitcoin-only CSV has one check and no BNB refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-btc-csv-'));
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => result(address, network) });
  try {
    const link = await jobs.receive(Readable.from(`address\n${btc}\n`), { kind: 'addresses' });
    const status = await finished(jobs, link);
    assert.equal(status.total, 1); assert.equal(status.completed, 1); assert.equal(status.hiddenWallets, 1);
    assert.equal(status.hasBnbChecks, false); assert.equal(jobs.refreshBnb(link.id, link.token), false);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid CSV, unsupported columns, and invalid UTF-8 fail without scanning', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-invalid-csv-'));
  let scans = 0;
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => { scans++; return result(address, network); } });
  try {
    const fixtures = [
      { bytes: Buffer.from('private_key,status\nsecret,ok\n'), message: /recognized public-address column/i },
      { bytes: Buffer.from('bitcoin,ethereum\nnot-a-bitcoin,not-an-evm\n'), message: /no valid supported public addresses/i, invalid: 2 },
      { bytes: Buffer.from(`bitcoin,ethereum\n${evm1},${btc}\n`), message: /no valid supported public addresses/i, invalid: 2 },
      { bytes: Buffer.from(`address,notes\n${evm1},${'x'.repeat(70 * 1024)}\n`), message: /CSV record exceeds/i },
      { bytes: Buffer.from(`address\n${evm1}${','.repeat(200)}\n`), message: /more than 128 columns/i },
      { bytes: Buffer.from(`address\n${evm1}\n"unclosed`), message: /could not process.*csv/i },
      { bytes: Buffer.concat([Buffer.from('address\n'), Buffer.from([0xff])]), message: /valid UTF-8|could not process.*csv/i },
      { bytes: Buffer.alloc(0), message: /recognized public-address column/i },
    ];
    for (const fixture of fixtures) {
      const link = await jobs.receive(Readable.from(fixture.bytes), { kind: 'addresses' });
      const status = await finished(jobs, link);
      assert.equal(status.status, 'failed'); assert.match(status.error, fixture.message);
      if (fixture.invalid !== undefined) assert.equal(status.invalid, fixture.invalid);
      assert.equal(status.hiddenWallets, 0); assert.equal(status.retainsPhrases, false);
      assert.equal(fs.existsSync(path.join(dir, `${link.id}.upload`)), false);
    }
    assert.equal(scans, 0);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted CSV import resumes without duplicate addresses or checks', { timeout: 25000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-csv-restart-'));
  const modulePath = path.resolve('lib/background-jobs.js');
  const source = `const {Readable}=require('node:stream');const {createBackgroundJobs}=require(${JSON.stringify(modulePath)});
    const j=createBackgroundJobs(process.argv[1],{scan:()=>new Promise(()=>{})});
    const csv='bitcoin,ethereum,bnb_smart_chain,base\\n'+${JSON.stringify(`${btc},${evm1},${evm1},${evm1}\n`)}.repeat(15000);
    (async()=>{const link=await j.receive(Readable.from(csv),{kind:'addresses'});const t=setInterval(()=>{const s=j.status(link.id,link.token);if(s.status==='importing'&&s.lines>=100){clearInterval(t);console.log(JSON.stringify(link));}},10)})();`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let jobs;
  try {
    const link = await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('CSV import child timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output)); } });
      child.on('error', reject); child.on('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`CSV import child exited ${code}`)); } });
    });
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(link.id).status, 'importing'); db.close();
    jobs = createBackgroundJobs(dir, { scan: async (address, network) => result(address, network, '1') });
    const status = await finished(jobs, link);
    assert.equal(status.status, 'finished'); assert.equal(status.lines, 15000);
    assert.equal(status.wallets, 2); assert.equal(status.total, 6); assert.equal(status.completed, 6);
    assert.equal(jobs.dashboard(link.id, link.token).assetCount, 6);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    jobs?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the streamed CSV byte limit rejects excess content without buffering it all', async () => {
  const sizes = []; const sink = () => new Writable({ write(chunk, _encoding, done) { sizes.push(chunk.length); done(); } });
  await pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(4)]), limitAddressCsvBytes(10), sink());
  assert.deepEqual(sizes, [6, 4]);
  sizes.length = 0;
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(5)]), limitAddressCsvBytes(10), sink()), error => error.code === 'TOO_LARGE');
  assert.deepEqual(sizes, [6]);
});

test('a transient database lock does not discard an acknowledged CSV', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-csv-locked-'));
  const original = createBackgroundJobs(dir, { scan: async (address, network) => result(address, network, '1') });
  let lock; let resumed;
  try {
    const csv = 'address\n' + `${evm1}\n`.repeat(1000);
    const link = await original.receive(Readable.from(csv), { kind: 'addresses' });
    lock = new DatabaseSync(path.join(dir, 'jobs.sqlite')); lock.exec('BEGIN IMMEDIATE');
    await new Promise(resolve => setTimeout(resolve, 200));
    lock.exec('ROLLBACK'); lock.close(); lock = null;
    assert.equal(original.status(link.id, link.token).status, 'importing');
    assert.equal(fs.existsSync(path.join(dir, `${link.id}.upload`)), true);
    original.close(); await new Promise(resolve => setTimeout(resolve, 200));
    resumed = createBackgroundJobs(dir, { scan: async (address, network) => result(address, network, '1') });
    const status = await finished(resumed, link);
    assert.equal(status.status, 'finished'); assert.equal(status.wallets, 1); assert.equal(status.total, 5);
  } finally {
    if (lock) { try { lock.exec('ROLLBACK'); lock.close(); } catch (_) {} }
    original.close(); resumed?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CSV scans share the configured queue with concurrent phrase-file jobs', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-csv-share-'));
  let active = 0; let maxActive = 0; let maxNetwork = 0; const byNetwork = new Map(); const owners = new Set();
  const jobs = createBackgroundJobs(dir, { concurrency: 5, perNetworkConcurrency: 1, scan: async (address, network) => {
    owners.add(address); active++; maxActive = Math.max(maxActive, active);
    byNetwork.set(network, (byNetwork.get(network) || 0) + 1); maxNetwork = Math.max(maxNetwork, byNetwork.get(network));
    try { await new Promise(resolve => setTimeout(resolve, 20)); return result(address, network, '1'); }
    finally { active--; byNetwork.set(network, byNetwork.get(network) - 1); }
  } });
  try {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const csv = await jobs.receive(Readable.from(`bitcoin,ethereum\n${btc},${evm1}\n`), { kind: 'addresses' });
    const upload = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    const [a, b] = await Promise.all([finished(jobs, csv), finished(jobs, upload)]);
    assert.equal(a.status, 'finished'); assert.equal(a.completed, 6); assert.equal(b.status, 'finished'); assert.equal(b.completed, 5);
    assert.ok(owners.has(btc)); assert.ok(owners.has(evm1)); assert.equal(owners.size, 3);
    assert.ok(maxActive <= 5); assert.ok(maxNetwork <= 1);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a single evm column checks every supported EVM network alongside Bitcoin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-compact-csv-'));
  const btc2 = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  const seen = []; const jobs = createBackgroundJobs(dir, { scan: async (address, network) => { seen.push([address, network]); return result(address, network, '1'); } });
  try {
    const csv = `phrase_line,btc_native_segwit,evm\n1,${btc},${evm1}\n2,${btc2},${evm2}\n`;
    const link = await jobs.receive(Readable.from(csv), { kind: 'addresses' });
    const status = await finished(jobs, link);
    assert.equal(status.status, 'finished'); assert.equal(status.lines, 2); assert.equal(status.invalid, 0);
    assert.equal(status.wallets, 4); assert.equal(status.total, 12); assert.equal(status.completed, 12);
    for (const address of [evm1, evm2]) {
      assert.deepEqual(seen.filter(item => item[0] === address).map(item => item[1]).sort(), ['arbitrum', 'base', 'bnb', 'ethereum', 'optimism']);
    }
    for (const address of [btc, btc2]) {
      assert.deepEqual(seen.filter(item => item[0] === address).map(item => item[1]), ['bitcoin']);
    }
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
