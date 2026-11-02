const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createBackgroundJobs } = require('../lib/background-jobs');
const { Wallet, Mnemonic } = require('ethers');
const { BUSD_BSC } = require('../lib/prices');

// Public test phrase. Never fund this account.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wait = () => new Promise(resolve => setTimeout(resolve, 40));
const zeroBusd = { type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '0', decimals: 18, price: null };
const completeResult = (network, assets) => network === 'bnb' ? { coverage: 'bnb-and-busd', assets: [...assets, zeroBusd] } : { assets };
const fakeScan = async (_address, network) => completeResult(network, [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '100', decimals: 18, price: null }]);
async function finished(jobs, id, token) {
  for (let i = 0; i < 300; i++) {
    const status = jobs.status(id, token);
    if (status && ['finished', 'failed'].includes(status.status)) return status;
    await wait();
  }
  throw new Error('Timed out waiting for background job');
}

test('background jobs process a file, authenticate access and retain results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-jobs-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const { id, token } = await jobs.receive(Readable.from(`${phrase}\n${phrase}\ninvalid\n`), { retainPhrases: true });
    assert.equal(jobs.status(id, '0'.repeat(64)), null);
    const status = await finished(jobs, id, token);
    assert.equal(status.status, 'finished');
    assert.equal(status.wallets, 1);
    assert.equal(status.invalid, 1);
    assert.equal(status.total, 5);
    assert.equal(status.completed, 5);
    assert.equal(status.incomplete, 0);
    const result = jobs.results(id, token);
    assert.equal(result.checks.length, 5);
    assert.ok(result.checks.every(check => check.status === 'done'));
    assert.equal(status.retainsPhrases, true);
    const matches = jobs.matches(id, token);
    assert.equal(matches.total, 1);
    assert.equal(matches.matches[0].phrase, undefined); // Reveal is an explicit separate request.
    assert.equal(jobs.phrase(id, token, result.checks[0].address), phrase);
    assert.equal(jobs.phrase(id, '0'.repeat(64), result.checks[0].address), null);
    assert.equal(fs.existsSync(path.join(dir, `${id}.upload`)), false);
    for (const file of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, file)).includes(Buffer.from(phrase)), false);
    assert.equal(jobs.remove(id, token), true);
    assert.equal(jobs.status(id, token), null);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed and partial checks remain incomplete and can be retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-jobs-'));
  let retry = false;
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => {
    if (!retry && network === 'base') throw new Error('offline');
    if (!retry && network === 'arbitrum') return { ...(await fakeScan(address, network)), coverage: 'native-only' };
    return fakeScan(address, network);
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase));
    const first = await finished(jobs, id, token);
    assert.equal(first.incomplete, 2);
    assert.equal(jobs.results(id, token).checks.filter(check => check.status === 'partial').length, 1);
    retry = true;
    assert.equal(jobs.retry(id, token), true);
    assert.equal((await finished(jobs, id, token)).incomplete, 0);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('complete zero-balance scans discard every retained phrase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-zero-'));
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => completeResult(network,
    [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '0', decimals: 18, price: null }]) });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    const status = await finished(jobs, id, token);
    assert.equal(status.incomplete, 0);
    assert.equal(status.retainsPhrases, false);
    assert.equal(jobs.matches(id, token).total, 0);
    assert.equal(jobs.phrase(id, token, Wallet.fromPhrase(phrase).address), null);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retained phrases stay available across incomplete retries and are pruned when unmatched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-matches-'));
  const positiveAddress = Wallet.fromPhrase(phrase).address;
  const zeroPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const zeroAddress = Wallet.fromPhrase(zeroPhrase).address;
  let retry = false;
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => {
    if (address === positiveAddress && network === 'ethereum' && !retry) throw new Error('offline');
    const balance = address === positiveAddress && network === 'ethereum' && retry ? '1' : '0';
    return completeResult(network, [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: balance, decimals: 18, price: null }]);
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(`${phrase}\n${zeroPhrase}`), { retainPhrases: true });
    const first = await finished(jobs, id, token);
    assert.equal(first.incomplete, 1);
    assert.equal(first.retainsPhrases, true);
    assert.equal(jobs.matches(id, token).total, 0);
    assert.equal(jobs.phrase(id, token, positiveAddress), null);

    retry = true;
    assert.equal(jobs.retry(id, token), true);
    const final = await finished(jobs, id, token);
    assert.equal(final.incomplete, 0);
    const matches = jobs.matches(id, token);
    assert.equal(matches.total, 1);
    assert.equal(matches.matches[0].address, positiveAddress);
    assert.equal(jobs.phrase(id, token, positiveAddress), phrase);
    assert.equal(jobs.phrase(id, token, zeroAddress), null);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing jobs migrate safely and are marked as lacking phrase mappings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-migrate-'));
  const id = 'a'.repeat(64);
  const token = 'b'.repeat(64);
  const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT, iv TEXT, tag TEXT, lines INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE wallets (job TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(job,address));
    CREATE TABLE checks (job TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, assets TEXT, reason TEXT, PRIMARY KEY(job,address,network));`);
  db.prepare(`INSERT INTO jobs (id,token_hash,status,created_at) VALUES (?,?,'finished',?)`).run(id, crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
  const address = Wallet.fromPhrase(phrase).address;
  db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)').run(id, address);
  db.prepare(`INSERT INTO checks (job,address,network,status,assets) VALUES (?,?,?,'done',?)`).run(id, address, 'ethereum', JSON.stringify([{ type: 'native', symbol: 'ETH', rawBalance: '1', decimals: 0, price: null }]));
  db.close();
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const status = jobs.status(id, token);
    assert.equal(status.phraseMatching, false);
    assert.equal(status.retainsPhrases, false);
    assert.equal(jobs.matches(id, token).enabled, false);
    assert.equal(jobs.dashboard(id, token).assetCount, 1, 'legacy positive checks remain visible after migration');
    const migratedDb = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    assert.ok(migratedDb.prepare('PRAGMA index_list(checks)').all().some(index => index.name === 'checks_pending_idx'));
    const plan = migratedDb.prepare("EXPLAIN QUERY PLAN SELECT address,network FROM checks WHERE job = ? AND network = ? AND status = 'pending' ORDER BY address LIMIT 1").all(id, 'ethereum');
    assert.match(JSON.stringify(plan), /checks_pending_network_idx/);
    migratedDb.close();
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('background scans resume after their process is interrupted', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-resume-'));
  const modulePath = require.resolve('../lib/background-jobs');
  const source = `const {Readable}=require('node:stream'); const {createBackgroundJobs}=require(${JSON.stringify(modulePath)}); setInterval(()=>{},1000); const j=createBackgroundJobs(process.argv[1],{scan:()=>new Promise(()=>{})}); j.receive(Readable.from(${JSON.stringify(phrase)})).then(v=>console.log(JSON.stringify(v)));`;
  const child = spawn(process.execPath, ['-e', source, dir], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const creds = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child timeout')), 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output)); } });
    child.on('error', reject);
  });
  // Give the first worker time to mark checks running before the crash.
  await wait(); child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const status = await finished(jobs, creds.id, creds.token);
    assert.equal(status.status, 'finished');
    assert.equal(status.completed, 5);
    assert.equal(status.incomplete, 0);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid UTF-8 is reported as a failed import, not an empty or successful scan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-jobs-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const { id, token } = await jobs.receive(Readable.from([Buffer.from('invalid'), Buffer.from([0xff])]));
    const status = await finished(jobs, id, token);
    assert.equal(status.status, 'failed');
    assert.equal(status.completed, 0);
    assert.match(status.error, /UTF-8/);
    assert.equal(fs.existsSync(path.join(dir, `${id}.upload`)), false);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an interrupted upload is not accepted as a background job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-jobs-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const stream = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('connection lost'); })());
    await assert.rejects(jobs.receive(stream));
    assert.equal(fs.readdirSync(dir).some(file => file.endsWith('.upload')), false);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the dashboard pages positive assets and wallet states on the server without exposing phrases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-dashboard-'));
  const address = Wallet.fromPhrase(phrase).address;
  const zeroPhrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const zeroAddress = Wallet.fromPhrase(zeroPhrase).address;
  let retry = false;
  const jobs = createBackgroundJobs(dir, { scan: async (owner, network) => {
    if (owner === zeroAddress && network === 'base' && !retry) throw new Error('offline');
    if (owner !== address || network !== 'ethereum') return completeResult(network, [{ type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null }]);
    return { assets: [
      { name: 'Ether', type: 'native', symbol: 'ETH', rawBalance: '1000000000000000000', decimals: 18, price: '2' },
      ...Array.from({ length: 103 }, (_, i) => ({ name: `Token ${i}`, type: 'ERC-20', symbol: 'TOK', rawBalance: '2', decimals: 0, price: '3' })),
      { name: 'NFT', type: 'ERC-721', symbol: 'NFT', rawBalance: '1', decimals: 0, price: '999' },
      { name: 'Missing price', type: 'token', symbol: 'NO', rawBalance: '1', decimals: 0, price: 'not a number' },
      { name: 'Zero', type: 'token', symbol: 'ZERO', rawBalance: '0000', decimals: 0, price: '1' },
    ] };
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(`${phrase}\n${zeroPhrase}\n`), { retainPhrases: true });
    await finished(jobs, id, token);
    assert.equal(jobs.dashboard(id, '0'.repeat(64)), null);
    const first = jobs.dashboard(id, token);
    assert.equal(first.wallets, 2); assert.equal(first.assetCount, 106); assert.equal(first.filteredAssetCount, 106);
    assert.equal(first.knownValue, 620); assert.equal(first.unpriced, 2); assert.equal(first.incomplete, 1);
    assert.equal(first.assets.length, 100); assert.equal(first.walletPage.length, 2);
    assert.equal(first.walletPage.find(item => item.address === address).hasAssets, true);
    assert.equal(first.walletPage.find(item => item.address === zeroAddress).incomplete, 1);
    assert.equal(JSON.stringify(first).includes(phrase), false);
    const second = jobs.dashboard(id, token, { assetOffset: 100, walletOffset: 1, network: 'ethereum' });
    assert.equal(second.assets.length, 6); assert.equal(second.walletPage.length, 1);
    assert.equal(second.filteredAssetCount, 106); assert.ok(second.assets.every(item => item.network === 'ethereum'));
    const filtered = jobs.dashboard(id, token, { network: 'base' });
    assert.equal(filtered.assetCount, 106); assert.equal(filtered.filteredAssetCount, 0); assert.equal(filtered.assets.length, 0);
    retry = true; assert.equal(jobs.retry(id, token), true); await finished(jobs, id, token);
    const final = jobs.dashboard(id, token);
    assert.equal(final.incomplete, 0); assert.equal(final.assetCount, 106); assert.equal(final.knownValue, 620);
    assert.equal(final.visibleWallets, 1); assert.equal(final.hiddenWallets, 1);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT address,network FROM checks INDEXED BY checks_positive_idx WHERE job = ? AND has_positive = 1 ORDER BY address,network').all(id);
    assert.match(JSON.stringify(plan), /checks_positive_idx/);
    const recentPlan = db.prepare('EXPLAIN QUERY PLAN SELECT address,network FROM checks INDEXED BY checks_recent_positive_idx WHERE job = ? AND has_positive = 1 ORDER BY positive_at DESC,address,network LIMIT 12').all(id);
    assert.match(JSON.stringify(recentPlan), /checks_recent_positive_idx/);
    assert.doesNotMatch(JSON.stringify(recentPlan), /TEMP B-TREE/);
    const addWallet = db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)');
    const addCheck = db.prepare("INSERT INTO checks (job,address,network,status,has_positive) VALUES (?,?,'ethereum','done',0)");
    db.exec('BEGIN');
    for (let i = 0; i < 105; i++) {
      const synthetic = `0x${i.toString(16).padStart(40, '0')}`;
      addWallet.run(id, synthetic); addCheck.run(id, synthetic);
    }
    db.exec('COMMIT'); db.close();
    const walletFirst = jobs.dashboard(id, token, { walletOffset: 0 });
    const walletLast = jobs.dashboard(id, token, { walletOffset: 100 });
    assert.equal(walletFirst.wallets, 107); assert.equal(walletFirst.visibleWallets, 106); assert.equal(walletFirst.hiddenWallets, 1);
    assert.equal(walletFirst.walletPage.length, 100); assert.equal(walletLast.walletPage.length, 6);
    assert.equal(new Set([...walletFirst.walletPage, ...walletLast.walletPage].map(item => item.address)).size, 106);
    assert.equal(jobs.restoreHidden(id, token), 1);
    const restoredLast = jobs.dashboard(id, token, { walletOffset: 100 });
    assert.equal(restoredLast.visibleWallets, 107); assert.equal(restoredLast.hiddenWallets, 0);
    assert.equal(restoredLast.walletPage.length, 7);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server phrase retrieval refuses an encrypted phrase that does not derive the selected address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-verify-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  const address = Wallet.fromPhrase(phrase).address;
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    await finished(jobs, id, token);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const key = Buffer.from(db.prepare('SELECT phrase_key FROM jobs WHERE id=?').get(id).phrase_key, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${id}:${address}`));
    const other = 'test test test test test test test test test test test junk';
    const encrypted = Buffer.concat([cipher.update(other, 'utf8'), cipher.final()]);
    db.prepare('UPDATE retained_phrases SET iv=?, tag=?, ciphertext=? WHERE job=? AND address=?').run(iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex'), id, address);
    db.close();
    assert.equal(jobs.phrase(id, token, address), null);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acknowledged jobs keep processing without an attached browser and accept files over 25 MiB', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-large-'));
  let allowChecks; const gate = new Promise(resolve => { allowChecks = resolve; }); let started = 0;
  const jobs = createBackgroundJobs(dir, { scan: async (...args) => { started++; await gate; return fakeScan(...args); } });
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const source = Readable.from((async function* () {
      yield Buffer.from(`${phrase}\n`);
      for (let i = 0; i < 401; i++) yield chunk;
    })());
    const { id, token } = await jobs.receive(source, { retainPhrases: true });
    // No further upload stream or browser is involved once the job is acknowledged.
    for (let i = 0; i < 300 && !started; i++) await wait();
    assert.ok(started > 0, 'server started balance checks');
    assert.equal(jobs.status(id, token).status, 'scanning');
    allowChecks();
    const status = await finished(jobs, id, token);
    assert.equal(status.wallets, 1); assert.equal(status.invalid, 1); assert.equal(status.completed, 5);
    assert.equal(jobs.dashboard(id, token).assetCount, 5);
  } finally { allowChecks(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('multiple server file jobs share a bounded scanning queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-parallel-'));
  let active = 0; let maxActive = 0; let calls = 0;
  const jobs = createBackgroundJobs(dir, { scan: async (...args) => {
    active++; calls++; maxActive = Math.max(active, maxActive);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--; return fakeScan(...args);
  } });
  try {
    const first = await jobs.receive(Readable.from(phrase));
    const second = await jobs.receive(Readable.from(phrase));
    const results = await Promise.all([finished(jobs, first.id, first.token), finished(jobs, second.id, second.token)]);
    assert.ok(results.every(result => result.status === 'finished' && result.completed === 5));
    assert.equal(calls, 10); assert.ok(maxActive <= 12, `observed ${maxActive} concurrent provider checks`);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an 80,080-wallet job returns only the requested dashboard pages', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-large-dashboard-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const { id, token } = await jobs.receive(Readable.from(''));
    await finished(jobs, id, token);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const wallet = db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)');
    const check = db.prepare("INSERT INTO checks (job,address,network,status,has_positive) VALUES (?,?,?,'done',0)");
    db.exec('BEGIN');
    for (let i = 0; i < 80080; i++) {
      const owner = `0x${i.toString(16).padStart(40, '0')}`;
      wallet.run(id, owner);
      for (const network of ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb']) check.run(id, owner, network);
    }
    const owner = `0x${(80079).toString(16).padStart(40, '0')}`;
    const assets = JSON.stringify([{ type: 'native', name: 'Ether', symbol: 'ETH', rawBalance: '1000000000000000000', decimals: 18, price: '2' }]);
    db.prepare("UPDATE checks SET assets=?, has_positive=1 WHERE job=? AND address=? AND network='ethereum'").run(assets, id, owner);
    db.exec('COMMIT'); db.close();
    const page = jobs.dashboard(id, token, { walletOffset: 80000 });
    assert.equal(page.wallets, 80080); assert.equal(page.total, 400400); assert.equal(page.completed, 400400);
    assert.equal(page.walletPage.length, 80); assert.equal(page.assetCount, 1); assert.equal(page.assets.length, 1);
    assert.equal(page.assets[0].address, owner); assert.equal(page.knownValue, 2);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backfills positive balances in legacy jobs where the column already existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-backfill-'));
  const id = 'a'.repeat(64); const token = 'b'.repeat(64);
  const address = Wallet.fromPhrase(phrase).address;
  const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT, iv TEXT, tag TEXT, lines INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, error TEXT, phrase_key TEXT, retain_phrases INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE wallets (job TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(job,address));
    CREATE TABLE checks (job TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, assets TEXT, reason TEXT, has_positive INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job,address,network));`);
  db.prepare(`INSERT INTO jobs (id,token_hash,status,created_at) VALUES (?,?,'finished',?)`).run(id, crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
  db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)').run(id, address);
  db.prepare(`INSERT INTO checks (job,address,network,status,assets) VALUES (?,?,?,'done',?)`).run(id, address, 'ethereum', JSON.stringify([{ type: 'native', symbol: 'ETH', rawBalance: '1', decimals: 0, price: null }]));
  db.close();
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    assert.equal(jobs.dashboard(id, token).assetCount, 1);
    assert.equal(jobs.dashboard(id, token).assets[0].address, address);
    assert.equal(jobs.dashboard(id, token).phraseMatching, false);
    const migrated = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    assert.ok(migrated.prepare("SELECT 1 FROM background_migrations WHERE name = 'backfill-positive-assets-v1'").get());
    assert.ok(migrated.prepare("SELECT 1 FROM background_migrations WHERE name = 'generated-counters-v1'").get());
    migrated.close();
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BUSD-only matches retain their phrase; failed refresh keeps the last balance and can be retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-busd-'));
  const address = Wallet.fromPhrase(phrase).address; let mode = 'initial';
  const native = { type: 'native', name: 'BNB', symbol: 'BNB', rawBalance: '0', decimals: 18, price: null };
  const busd = amount => ({ type: 'BEP-20', name: 'Binance-Peg BUSD', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: amount, decimals: 18, price: null });
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => {
    if (network !== 'bnb') return { assets: [{ ...native, symbol: 'ETH' }] };
    if (mode === 'failed') return { coverage: 'native-only', assets: [native] };
    return { coverage: 'bnb-and-busd', assets: [native, busd(mode === 'initial' ? '2000000000000000000' : '3000000000000000000')] };
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    assert.equal((await finished(jobs, id, token)).incomplete, 0);
    let page = jobs.dashboard(id, token, { prices: { busd: 0.97 } });
    assert.equal(page.assetCount, 1); assert.equal(page.knownValue, 1.94); assert.equal(page.unpriced, 0);
    assert.equal(page.assets[0].asset.price, 0.97); assert.equal(page.assets[0].phraseAvailable, true);
    assert.equal(jobs.phrase(id, token, address), phrase);
    mode = 'failed'; assert.equal(jobs.refreshBnb(id, token), true);
    assert.equal((await finished(jobs, id, token)).incomplete, 1);
    page = jobs.dashboard(id, token, { prices: { busd: 0.98 } });
    assert.equal(page.assetCount, 1); assert.equal(page.assets[0].status, 'partial');
    assert.equal(page.assets[0].asset.rawBalance, '2000000000000000000'); assert.equal(page.knownValue, 1.96);
    assert.equal(jobs.phrase(id, token, address), phrase);
    mode = 'updated'; assert.equal(jobs.retry(id, token), true);
    assert.equal((await finished(jobs, id, token)).incomplete, 0);
    page = jobs.dashboard(id, token, { prices: { busd: 0.98 } });
    assert.equal(page.assets[0].asset.rawBalance, '3000000000000000000'); assert.equal(page.knownValue, 2.94);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('older BNB checks migrate to retryable BUSD checks without pretending pruned phrases can be recovered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-busd-migration-'));
  const phrase2 = 'test test test test test test test test test test test junk';
  const a = Wallet.fromPhrase(phrase).address; const b = Wallet.fromPhrase(phrase2).address;
  const native = balance => ({ type: 'native', symbol: 'ETH', rawBalance: balance, decimals: 18, price: null });
  let jobs = createBackgroundJobs(dir, { scan: async (address, network) => completeResult(network, [native(address === a && network === 'ethereum' ? '1' : '0')]) });
  let id, token;
  try {
    ({ id, token } = await jobs.receive(Readable.from(`${phrase}\n${phrase2}`), { retainPhrases: true }));
    assert.equal((await finished(jobs, id, token)).incomplete, 0);
    assert.equal(jobs.phrase(id, token, a), phrase); assert.equal(jobs.phrase(id, token, b), null);
    jobs.close();
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    db.prepare("UPDATE checks SET assets = json_array(json_extract(assets, '$[0]')) WHERE network = 'bnb'").run();
    db.prepare('DELETE FROM background_migrations WHERE name = ?').run('bnb-busd-coverage-v1'); db.close();
    const calls = [];
    jobs = createBackgroundJobs(dir, { scan: async (address, network) => {
      calls.push({ address, network });
      return { coverage: 'bnb-and-busd', assets: [native('0'), { type: 'BEP-20', name: 'Binance-Peg BUSD', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '1000000000000000000', decimals: 18, price: null }] };
    } });
    assert.equal(jobs.status(id, token).incomplete, 2);
    const before = jobs.results(id, token).checks.filter(c => c.network === 'bnb');
    assert.ok(before.every(c => c.status === 'partial' && /BUSD was not checked/.test(c.reason)));
    assert.equal(jobs.retry(id, token), true); assert.equal((await finished(jobs, id, token)).incomplete, 0);
    assert.equal(calls.length, 2); assert.ok(calls.every(c => c.network === 'bnb'));
    const page = jobs.dashboard(id, token, { prices: { busd: 0.95 } });
    assert.equal(page.assets.filter(row => row.asset.symbol === 'BUSD').length, 2);
    assert.equal(page.assets.find(row => row.address === a && row.asset.symbol === 'BUSD').phraseAvailable, true);
    assert.equal(page.assets.find(row => row.address === b && row.asset.symbol === 'BUSD').phraseAvailable, false);
    assert.equal(jobs.phrase(id, token, a), phrase); assert.equal(jobs.phrase(id, token, b), null);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server totals price BNB and canonical BUSD across all pages, not just visible rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-busd-pages-'));
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const { id, token } = await jobs.receive(Readable.from('invalid line'));
    await finished(jobs, id, token);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const addWallet = db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)');
    const addCheck = db.prepare("INSERT INTO checks (job,address,network,status,assets,has_positive) VALUES (?,?,'bnb','done',?,1)");
    const assets = JSON.stringify([
      { type: 'native', symbol: 'BNB', rawBalance: '1000000000000000000', decimals: 18, price: null },
      { type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '2000000000000000000', decimals: 18, price: null },
      { type: 'BEP-20', symbol: 'BUSD', contract: '0x1111111111111111111111111111111111111111', rawBalance: '1000000000000000000', decimals: 18, price: null },
    ]);
    db.exec('BEGIN');
    for (let i = 1; i <= 105; i++) {
      const address = `0x${i.toString(16).padStart(40, '0')}`;
      addWallet.run(id, address); addCheck.run(id, address, assets);
    }
    db.exec('COMMIT'); db.close();
    const page = jobs.dashboard(id, token, { prices: { bnb: 600, busd: 0.99 } });
    assert.equal(page.assetCount, 315); assert.equal(page.assets.length, 100); assert.equal(page.unpriced, 105);
    assert.ok(Math.abs(page.knownValue - (600 + 2 * 0.99) * 105) < 0.001);
    assert.equal(page.assets.find(row => row.asset.contract === BUSD_BSC).asset.price, 0.99);
    assert.equal(page.assets.find(row => row.asset.symbol === 'BUSD' && row.asset.contract !== BUSD_BSC).asset.price, null);
    const second = jobs.dashboard(id, token, { assetOffset: 100, prices: { bnb: 600, busd: 0.99 } });
    assert.equal(second.assets.length, 100); assert.equal(second.knownValue, page.knownValue);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('five-wallet EC2 job progresses on healthy networks while a provider is slow, with bounded shared concurrency', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-network-fair-'));
  const phrases = Array.from({ length: 5 }, (_, index) => Mnemonic.fromEntropy(`0x${(index + 1).toString(16).padStart(32, '0')}`).phrase);
  const held = []; const activeByNetwork = {}; const peaks = {}; let active = 0; let peak = 0; let hold = true;
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => {
    active++; peak = Math.max(peak, active); activeByNetwork[network] = (activeByNetwork[network] || 0) + 1;
    peaks[network] = Math.max(peaks[network] || 0, activeByNetwork[network]);
    try {
      if (network === 'ethereum' && hold) await new Promise(resolve => held.push(resolve));
      else await new Promise(resolve => setTimeout(resolve, 5));
      return completeResult(network, [{ type: 'native', name: network, symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '1000000000000000000', decimals: 18, price: '2' }]);
    } finally { active--; activeByNetwork[network]--; }
  } });
  let id, token;
  try {
    ({ id, token } = await jobs.receive(Readable.from(phrases.join('\n'))));
    let status;
    for (let i = 0; i < 200; i++) { status = jobs.status(id, token); if (status.completed === 20) break; await wait(); }
    assert.equal(status.status, 'scanning'); assert.equal(status.completed, 20);
    assert.equal(held.length, 3);
    let page = jobs.dashboard(id, token);
    assert.equal(page.assetCount, 20); assert.equal(page.knownValue, 40);
    assert.ok(peak <= 12, `global peak ${peak}`);
    assert.ok(Object.values(peaks).every(value => value <= 3), JSON.stringify(peaks));
    hold = false; held.forEach(resolve => resolve());
    assert.equal((await finished(jobs, id, token)).completed, 25);
    page = jobs.dashboard(id, token);
    assert.equal(page.assetCount, 25); assert.equal(page.knownValue, 50);
  } finally {
    hold = false; held.forEach(resolve => resolve());
    if (id) await finished(jobs, id, token).catch(() => {});
    jobs.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EC2 retries merge independent partial components, mark retained balances stale and keep phrase guards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-parts-'));
  const address = Wallet.fromPhrase(phrase).address; let phase = 'tokens';
  const zero = { type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null };
  const native = { ...zero, name: 'Ether', rawBalance: '1000000000000000000', price: '2' };
  const asset = { type: 'ERC-20', name: 'Token', symbol: 'TOK', contract: '0x2222222222222222222222222222222222222222', rawBalance: '2', decimals: 0, price: '3' };
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => {
    if (network !== 'base') return completeResult(network, [zero]);
    if (phase === 'tokens') return { coverage: 'tokens-only', components: { native: false, tokens: true }, assets: [asset] };
    if (phase === 'native') return { coverage: 'native-only', components: { native: true, tokens: false }, assets: [native] };
    return { assets: [native, { ...asset, rawBalance: '3' }] };
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    assert.equal((await finished(jobs, id, token)).incomplete, 1);
    let page = jobs.dashboard(id, token);
    assert.equal(page.assetCount, 1); assert.equal(page.knownValue, 6);
    assert.equal(page.assets[0].asset.stale, false); assert.equal(page.assets[0].status, 'partial');
    assert.equal(jobs.phrase(id, token, address), phrase);
    phase = 'native'; assert.equal(jobs.retry(id, token), true);
    assert.equal((await finished(jobs, id, token)).incomplete, 1);
    page = jobs.dashboard(id, token);
    assert.equal(page.assetCount, 2); assert.equal(page.knownValue, 8);
    assert.equal(page.assets.find(row => row.asset.symbol === 'ETH').asset.stale, false);
    assert.equal(page.assets.find(row => row.asset.symbol === 'TOK').asset.stale, true);
    assert.equal(jobs.phrase(id, token, address), phrase);
    phase = 'complete'; assert.equal(jobs.retry(id, token), true);
    assert.equal((await finished(jobs, id, token)).incomplete, 0);
    page = jobs.dashboard(id, token);
    assert.equal(page.assetCount, 2); assert.equal(page.knownValue, 11);
    assert.ok(page.assets.every(row => row.asset.stale === false));
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a mismatched provider wallet cannot create an asset or expose a recovery phrase', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-wrong-owner-'));
  const address = Wallet.fromPhrase(phrase).address;
  const zero = { type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null };
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => network === 'base'
    ? { address: '0x2222222222222222222222222222222222222222', network, assets: [{ ...zero, rawBalance: '1000000000000000000', price: '2' }] }
    : completeResult(network, [zero]) });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    const status = await finished(jobs, id, token);
    assert.equal(status.incomplete, 1); assert.equal(status.retainsPhrases, true, 'an incomplete scan cannot prune the phrase');
    assert.equal(jobs.dashboard(id, token).assetCount, 0);
    assert.equal(jobs.matches(id, token).total, 0);
    assert.equal(jobs.phrase(id, token, address), null, 'no positive verified balance means no phrase export');
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configured EC2 worker limits increase parallel checks without exceeding either bound', { timeout: 15000 }, async () => {
  const { readWorkerLimits } = require('../lib/worker-config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-worker-config-'));
  const phrases = Array.from({ length: 5 }, (_, index) => Mnemonic.fromEntropy(`0x${(index + 1).toString(16).padStart(32, '0')}`).phrase);
  const held = []; const activeByNetwork = {}; const peaks = {}; let active = 0; let peak = 0; let hold = true;
  const limits = readWorkerLimits({ WALLETO_SCAN_CONCURRENCY: '20', WALLETO_SCAN_PER_NETWORK: '4' });
  const jobs = createBackgroundJobs(dir, { ...limits, scan: async (_address, network) => {
    active++; peak = Math.max(peak, active); activeByNetwork[network] = (activeByNetwork[network] || 0) + 1;
    peaks[network] = Math.max(peaks[network] || 0, activeByNetwork[network]);
    try {
      if (hold) await new Promise(resolve => held.push(resolve));
      return completeResult(network, [{ type: 'native', name: network, symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '1', decimals: 18, price: null }]);
    } finally { active--; activeByNetwork[network]--; }
  } });
  let id, token;
  try {
    ({ id, token } = await jobs.receive(Readable.from(phrases.join('\n'))));
    for (let i = 0; i < 200 && held.length < 20; i++) await wait();
    assert.equal(held.length, 20, 'configured worker reaches the new global limit');
    assert.equal(peak, 20);
    assert.deepEqual(Object.values(peaks).sort(), [4, 4, 4, 4, 4]);
    const status = jobs.status(id, token);
    assert.equal(status.status, 'scanning'); assert.equal(status.completed, 0);
    hold = false; held.forEach(resolve => resolve());
    const final = await finished(jobs, id, token);
    assert.equal(final.completed, 25); assert.equal(final.incomplete, 0);
    assert.ok(peak <= 20);
    assert.ok(Object.values(peaks).every(value => value <= 4));
  } finally {
    hold = false; held.forEach(resolve => resolve());
    if (id) await finished(jobs, id, token).catch(() => {});
    jobs.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one automatic EC2 job continuously generates valid 128-bit combinations and scans only public addresses', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-'));
  const calls = [];
  const jobs = createBackgroundJobs(dir, { scan: async (owner, network) => { calls.push({ owner, network }); return fakeScan(owner, network); } });
  try {
    const { id, token, kind } = jobs.generate();
    assert.equal(kind, 'generated'); assert.equal(jobs.generate(), null, 'only one automatic producer runs at a time');
    for (let i = 0; i < 200 && (jobs.status(id, token)?.wallets || 0) < 20; i++) await wait();
    const running = jobs.status(id, token);
    assert.equal(running.status, 'scanning'); assert.equal(running.generationActive, true);
    assert.ok(running.wallets >= 20); assert.equal(running.generationTarget, 100);
    assert.equal(jobs.stopGeneration(id, '0'.repeat(64)), false);
    assert.equal(jobs.stopGeneration(id, token), true);
    const status = await finished(jobs, id, token);
    assert.equal(status.generationActive, false); assert.equal(status.incomplete, 0);
    assert.equal(status.total, status.wallets * 5); assert.equal(status.completed, status.total);
    const dashboard = jobs.dashboard(id, token); assert.equal(dashboard.assetCount, status.total);
    const owner = dashboard.walletPage[0].address;
    const generated = jobs.phrase(id, token, owner);
    assert.equal(generated.trim().split(/\s+/).length, 12);
    assert.equal(Mnemonic.isValidMnemonic(generated), true);
    assert.equal(Mnemonic.fromPhrase(generated).entropy.length, 34);
    assert.equal(Wallet.fromPhrase(generated).address, owner);
    assert.equal(JSON.stringify(dashboard).includes(generated), false);
    assert.equal(JSON.stringify(calls).includes(generated), false);
    assert.equal(jobs.phrase(id, '0'.repeat(64), owner), null);
    for (const file of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, file)).includes(Buffer.from(generated)), false);
    assert.equal(calls.length, status.total); assert.ok(calls.every(call => /^0x[0-9a-f]{40}$/i.test(call.owner)));
    const after = status.wallets; await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(jobs.status(id, token).wallets, after, 'stopped job does not add more wallets');
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generated zero wallets hide recoverably, while failed checks remain visible and retain encrypted phrases', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-zero-'));
  let failBase = false;
  const jobs = createBackgroundJobs(dir, { generationBatchSize: 1, generationRate: 5, scan: async (_owner, network) => {
    if (network === 'base' && failBase) throw new Error('offline');
    return completeResult(network, [{ type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null }]);
  } });
  try {
    const zero = jobs.generate();
    for (let i = 0; i < 200 && !(jobs.status(zero.id, zero.token)?.hiddenWallets); i++) await wait();
    assert.equal(jobs.stopGeneration(zero.id, zero.token), true);
    const complete = await finished(jobs, zero.id, zero.token);
    assert.ok(complete.wallets >= 1); assert.equal(complete.hiddenWallets, complete.wallets); assert.equal(complete.visibleWallets, 0);
    assert.equal(complete.retainsPhrases, false);
    assert.equal(jobs.restoreHidden(zero.id, zero.token), complete.wallets);
    const restored = jobs.dashboard(zero.id, zero.token);
    assert.equal(restored.visibleWallets, complete.wallets); assert.ok(restored.walletPage.length > 0);
    assert.equal(jobs.phrase(zero.id, zero.token, restored.walletPage[0].address), null, 'discarded empty phrase is not recoverable');
    assert.equal(jobs.refreshBnb(zero.id, zero.token), true);
    const refreshed = await finished(jobs, zero.id, zero.token);
    assert.equal(refreshed.completed, refreshed.total); assert.equal(refreshed.incomplete, 0);
    assert.equal(refreshed.hiddenWallets, refreshed.wallets);
    failBase = true;
    const incomplete = jobs.generate();
    for (let i = 0; i < 200 && !(jobs.status(incomplete.id, incomplete.token)?.incomplete); i++) await wait();
    assert.equal(jobs.stopGeneration(incomplete.id, incomplete.token), true);
    const partial = await finished(jobs, incomplete.id, incomplete.token);
    assert.ok(partial.incomplete >= 1); assert.equal(partial.hiddenWallets, 0);
    assert.equal(partial.visibleWallets, partial.wallets); assert.equal(partial.retainsPhrases, true);
    failBase = false; assert.equal(jobs.retry(incomplete.id, incomplete.token), true);
    const retried = await finished(jobs, incomplete.id, incomplete.token);
    assert.equal(retried.incomplete, 0); assert.equal(retried.hiddenWallets, retried.wallets); assert.equal(retried.retainsPhrases, false);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic generation applies backlog, provider-error and free-disk safeguards', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-bounds-'));
  let release; const gate = new Promise(resolve => { release = resolve; });
  let jobs = createBackgroundJobs(dir, { generationBatchSize: 3, generationMaxBacklog: 15,
    scan: async (owner, network) => { await gate; return fakeScan(owner, network); } });
  try {
    const first = jobs.generate();
    for (let i = 0; i < 200 && jobs.status(first.id, first.token).wallets < 3; i++) await wait();
    await new Promise(resolve => setTimeout(resolve, 350));
    const limited = jobs.status(first.id, first.token);
    assert.equal(limited.wallets, 3); assert.equal(limited.total, 15); assert.equal(limited.completed, 0);
    release();
    for (let i = 0; i < 200 && jobs.status(first.id, first.token).wallets <= 3; i++) await wait();
    assert.ok(jobs.status(first.id, first.token).wallets > 3, 'generation resumes when backlog drains');
    jobs.stopGeneration(first.id, first.token); await finished(jobs, first.id, first.token); jobs.close();
    jobs = createBackgroundJobs(dir, { generationBatchSize: 100, generationRate: 10000, generationMaxBacklog: 2000, generationMaxIncomplete: 1,
      scan: async () => { throw new Error('offline'); } });
    const failures = jobs.generate();
    let failed;
    for (let i = 0; i < 500 && (failed = jobs.status(failures.id, failures.token)).incomplete <= 500; i++) await wait();
    assert.ok(failed.incomplete > 500, 'incomplete checks do not stop generation');
    assert.equal(failed.generationActive, true);
    assert.equal(jobs.stopGeneration(failures.id, failures.token), true);
    failed = await finished(jobs, failures.id, failures.token);
    assert.equal(failed.generationActive, false); assert.ok(failed.incomplete > 500);
    assert.match(failed.generationReason, /stopped by user/i); jobs.close();
    let diskAvailable = false;
    jobs = createBackgroundJobs(dir, { generationDiskAvailable: () => diskAvailable, generationDiskCheckInterval: 20,
      scan: async (owner, network) => fakeScan(owner, network) });
    const lowDisk = jobs.generate();
    for (let i = 0; i < 100 && !jobs.status(lowDisk.id, lowDisk.token).generationReason; i++) await wait();
    const paused = jobs.status(lowDisk.id, lowDisk.token);
    assert.equal(paused.status, 'scanning'); assert.equal(paused.generationActive, true);
    assert.match(paused.generationReason, /paused.*disk space.*resume/i);
    diskAvailable = true;
    for (let i = 0; i < 100 && (jobs.status(lowDisk.id, lowDisk.token).wallets === 0 || jobs.status(lowDisk.id, lowDisk.token).generationReason); i++) await wait();
    assert.ok(jobs.status(lowDisk.id, lowDisk.token).wallets > 0, 'generation resumes when free space recovers');
    assert.equal(jobs.status(lowDisk.id, lowDisk.token).generationReason, null);
    assert.equal(jobs.stopGeneration(lowDisk.id, lowDisk.token), true);
    await finished(jobs, lowDisk.id, lowDisk.token);
  } finally { release(); await wait(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a finished generator resumes the same job and safely renews a pruned phrase key', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-resume-'));
  let jobs = createBackgroundJobs(dir, { generationBatchSize: 2, scan: async (owner, network) =>
    completeResult(network, [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '0', decimals: 18, price: null }]) });
  let key;
  try {
    const link = jobs.generate();
    for (let i = 0; i < 200 && jobs.status(link.id, link.token).wallets === 0; i++) await wait();
    assert.ok(jobs.status(link.id, link.token).wallets > 0);
    assert.equal(jobs.stopGeneration(link.id, link.token), true);
    const firstFinish = await finished(jobs, link.id, link.token);
    const before = firstFinish.wallets;
    assert.equal(firstFinish.status, 'finished'); assert.equal(firstFinish.retainsPhrases, false);
    assert.equal(jobs.resumeGeneration(link.id, link.token), true);
    assert.equal(jobs.status(link.id, link.token).generationActive, true);
    for (let i = 0; i < 200 && jobs.status(link.id, link.token).wallets <= before; i++) await wait();
    assert.ok(jobs.status(link.id, link.token).wallets > before);
    assert.equal(jobs.stopGeneration(link.id, link.token), true);
    const resumedFinish = await finished(jobs, link.id, link.token);
    assert.equal(resumedFinish.status, 'finished'); assert.ok(resumedFinish.wallets > before);
    jobs.close();

    // Existing encrypted phrase rows must never be orphaned by generating a
    // replacement key when the stored key is missing/corrupt.
    jobs = createBackgroundJobs(dir, { generationBatchSize: 1, scan: fakeScan });
    const positive = jobs.generate();
    for (let i = 0; i < 200 && jobs.status(positive.id, positive.token).wallets === 0; i++) await wait();
    assert.equal(jobs.stopGeneration(positive.id, positive.token), true);
    await finished(jobs, positive.id, positive.token);
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    key = db.prepare('SELECT phrase_key FROM jobs WHERE id=?').get(positive.id).phrase_key;
    assert.ok(key); assert.ok(db.prepare('SELECT 1 FROM retained_phrases WHERE job=? LIMIT 1').get(positive.id));
    db.prepare('UPDATE jobs SET phrase_key = NULL WHERE id = ?').run(positive.id); db.close();
    assert.equal(jobs.resumeGeneration(positive.id, positive.token), false);
    assert.equal(jobs.status(positive.id, positive.token).status, 'finished');
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new positive remains visible during a large scan even beyond the first asset page and after restart', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recent-'));
  let releaseEthereum; let releaseBase; let jobs;
  const ethereum = new Promise(resolve => { releaseEthereum = resolve; });
  const base = new Promise(resolve => { releaseBase = resolve; });
  const result = [{ name: 'Recent Ether', type: 'native', symbol: 'ETH', rawBalance: '1000000000000000000', decimals: 18, price: '2' }];
  jobs = createBackgroundJobs(dir, { scan: async (_owner, network) => {
    if (network === 'ethereum') { await ethereum; return { assets: result }; }
    if (network === 'base') await base;
    return completeResult(network, [{ type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null }]);
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    for (let i = 0; i < 100 && jobs.status(id, token)?.status !== 'scanning'; i++) await wait();
    assert.equal(jobs.status(id, token).status, 'scanning');
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const addWallet = db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)');
    const addCheck = db.prepare("INSERT INTO checks (job,address,network,status,assets,has_positive,positive_at) VALUES (?,?,'ethereum','done',?,1,1)");
    db.exec('BEGIN');
    for (let i = 1; i <= 101; i++) {
      const owner = `0x${i.toString(16).padStart(40, '0')}`;
      addWallet.run(id, owner); addCheck.run(id, owner, JSON.stringify([{ ...result[0], name: 'Earlier Ether' }]));
    }
    db.exec('COMMIT'); db.close();
    releaseEthereum();
    let dashboard;
    for (let i = 0; i < 100; i++) {
      dashboard = jobs.dashboard(id, token);
      if (dashboard.recentAssets.some(row => row.address === Wallet.fromPhrase(phrase).address)) break;
      await wait();
    }
    const owner = Wallet.fromPhrase(phrase).address;
    assert.equal(dashboard.status, 'scanning');
    assert.equal(dashboard.assetCount, 102); assert.equal(dashboard.assets.length, 100);
    assert.equal(dashboard.assets.some(row => row.address === owner), false, 'new positive is beyond the address-sorted first page');
    assert.equal(dashboard.recentAssets[0].address, owner);
    assert.equal(dashboard.recentAssets[0].asset.name, 'Recent Ether');
    assert.equal(jobs.dashboard(id, token, { network: 'base' }).recentAssets.length, 0);
    assert.equal(jobs.phrase(id, token, owner), phrase);
    releaseBase(); await finished(jobs, id, token);
    jobs.close(); jobs = createBackgroundJobs(dir, { scan: fakeScan });
    const reopened = jobs.dashboard(id, token);
    assert.equal(reopened.recentAssets[0].address, owner);
    assert.equal(reopened.assetCount, 102);
    assert.ok(jobs.dashboard(id, token, { assetOffset: 100 }).assets.some(row => row.address === owner));
  } finally {
    releaseEthereum(); releaseBase();
    await wait(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic generation and queued checks resume after an abrupt worker restart', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-restart-'));
  const modulePath = path.resolve('lib/background-jobs.js');
  const source = `const {createBackgroundJobs}=require(${JSON.stringify(modulePath)});const j=createBackgroundJobs(process.argv[1],{scan:()=>new Promise(()=>{})});
    const link=j.generate();const timer=setInterval(()=>{const s=j.status(link.id,link.token);if(s.wallets>=10){clearInterval(timer);console.log(JSON.stringify(link));}},30);`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let jobs;
  try {
    const link = await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error('generation child timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output)); } });
      child.on('error', reject); child.on('exit', code => { if (code) { clearTimeout(timeout); reject(new Error(`generation child exited ${code}`)); } });
    });
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const before = db.prepare('SELECT generated_count, generation_active FROM jobs WHERE id = ?').get(link.id); db.close();
    assert.ok(before.generated_count >= 10); assert.equal(before.generation_active, 1);
    jobs = createBackgroundJobs(dir, { scan: fakeScan });
    for (let i = 0; i < 200 && jobs.status(link.id, link.token).wallets <= before.generated_count; i++) await wait();
    const resumed = jobs.status(link.id, link.token);
    assert.equal(resumed.generationActive, true); assert.ok(resumed.wallets > before.generated_count);
    assert.equal(jobs.stopGeneration(link.id, link.token), true);
    const done = await finished(jobs, link.id, link.token);
    assert.equal(done.completed, done.total); assert.equal(done.incomplete, 0);
    assert.ok(jobs.dashboard(link.id, link.token).assetCount > 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    jobs?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generation pacing is bounded independently of fast providers', { timeout: 12000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-rate-'));
  const choices = Array.from({ length: 20 }, (_, i) => {
    const entropy = Buffer.alloc(16); entropy.writeUInt32BE(i + 1000, 12);
    const value = Mnemonic.fromEntropy(entropy).phrase;
    return { phrase: value, address: Wallet.fromPhrase(value).address };
  });
  let cursor = 0;
  const jobs = createBackgroundJobs(dir, { generationRate: 10, generationBatchSize: 2,
    generateBatch: async count => choices.slice(cursor, cursor += count), scan: fakeScan });
  try {
    const link = jobs.generate();
    for (let i = 0; i < 100 && jobs.status(link.id, link.token).wallets < 2; i++) await wait();
    await new Promise(resolve => setTimeout(resolve, 550));
    const count = jobs.status(link.id, link.token).wallets;
    assert.ok(count >= 2 && count <= 8, `bounded 10/s producer generated ${count} wallets in this interval`);
    jobs.stopGeneration(link.id, link.token); await finished(jobs, link.id, link.token);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('automatic generation shares the existing fair bounded queue with uploaded jobs', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-share-'));
  let active = 0; let maxActive = 0; const perNetwork = new Map(); let maxPerNetwork = 0;
  const jobs = createBackgroundJobs(dir, { concurrency: 5, perNetworkConcurrency: 1, generationBatchSize: 2, scan: async (owner, network) => {
    active++; maxActive = Math.max(maxActive, active);
    perNetwork.set(network, (perNetwork.get(network) || 0) + 1); maxPerNetwork = Math.max(maxPerNetwork, perNetwork.get(network));
    try { await new Promise(resolve => setTimeout(resolve, 25)); return await fakeScan(owner, network); }
    finally { active--; perNetwork.set(network, perNetwork.get(network) - 1); }
  } });
  try {
    const generated = jobs.generate();
    for (let i = 0; i < 200 && !jobs.status(generated.id, generated.token).wallets; i++) await wait();
    const upload = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    const uploaded = await finished(jobs, upload.id, upload.token);
    assert.equal(uploaded.completed, 5); assert.equal(uploaded.incomplete, 0);
    assert.equal(jobs.status(generated.id, generated.token).generationActive, true);
    assert.equal(jobs.stopGeneration(generated.id, generated.token), true);
    const complete = await finished(jobs, generated.id, generated.token);
    assert.equal(complete.completed, complete.total); assert.equal(complete.incomplete, 0);
    assert.ok(maxActive <= 5); assert.ok(maxPerNetwork <= 1);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fatal database error waits for in-flight scans before releasing the job', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-error-'));
  const waiting = []; let lock;
  const jobs = createBackgroundJobs(dir, { concurrency: 5, perNetworkConcurrency: 1, generationRate: 1, generationBatchSize: 1,
    scan: async (owner, network) => { await new Promise(resolve => waiting.push(resolve)); return fakeScan(owner, network); } });
  try {
    const link = jobs.generate();
    for (let i = 0; i < 200 && waiting.length < 5; i++) await wait();
    assert.equal(waiting.length, 5); assert.equal(jobs.stopGeneration(link.id, link.token), true);
    lock = new DatabaseSync(path.join(dir, 'jobs.sqlite')); lock.exec('BEGIN IMMEDIATE');
    waiting.shift()(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(jobs.status(link.id, link.token).status, 'scanning');
    assert.equal(jobs.remove(link.id, link.token), false, 'the job remains active while other scans are still in flight');
    lock.exec('ROLLBACK'); lock.close(); lock = null;
    for (const release of waiting.splice(0)) release();
    for (let i = 0; i < 200 && jobs.status(link.id, link.token).status !== 'failed'; i++) await wait();
    const status = jobs.status(link.id, link.token);
    assert.equal(status.status, 'failed'); assert.equal(status.generationActive, false);
    assert.equal(status.completed, 0); assert.equal(status.total, 5); assert.equal(status.hiddenWallets, 0);
    assert.equal(jobs.remove(link.id, link.token), true);
  } finally {
    if (lock) { try { lock.exec('ROLLBACK'); lock.close(); } catch (_) {} }
    for (const release of waiting) release();
    jobs.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing with scans in flight leaves generated work restartable', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-generated-shutdown-'));
  const waiting = []; let resumed;
  const jobs = createBackgroundJobs(dir, { generationBatchSize: 1,
    scan: async (owner, network) => { await new Promise(resolve => waiting.push(resolve)); return fakeScan(owner, network); } });
  try {
    const link = jobs.generate();
    for (let i = 0; i < 200 && waiting.length < 5; i++) await wait();
    assert.ok(waiting.length >= 5);
    jobs.close(); for (const release of waiting.splice(0)) release();
    await new Promise(resolve => setTimeout(resolve, 250));
    resumed = createBackgroundJobs(dir, { scan: fakeScan });
    for (let i = 0; i < 200 && resumed.status(link.id, link.token).wallets < 2; i++) await wait();
    assert.equal(resumed.status(link.id, link.token).generationActive, true);
    assert.equal(resumed.stopGeneration(link.id, link.token), true);
    const done = await finished(resumed, link.id, link.token);
    assert.equal(done.completed, done.total); assert.equal(done.incomplete, 0);
  } finally { for (const release of waiting) release(); jobs.close(); resumed?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fatal scan error retains already imported phrases and results', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-upload-error-'));
  const waiting = []; let lock;
  const jobs = createBackgroundJobs(dir, { concurrency: 5, perNetworkConcurrency: 1,
    scan: async (owner, network) => { await new Promise(resolve => waiting.push(resolve)); return fakeScan(owner, network); } });
  try {
    const link = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    for (let i = 0; i < 200 && waiting.length < 5; i++) await wait();
    assert.equal(waiting.length, 5);
    lock = new DatabaseSync(path.join(dir, 'jobs.sqlite')); lock.exec('BEGIN IMMEDIATE');
    waiting.shift()(); await new Promise(resolve => setTimeout(resolve, 100));
    lock.exec('ROLLBACK'); lock.close(); lock = null;
    for (const release of waiting.splice(0)) release();
    for (let i = 0; i < 200 && jobs.status(link.id, link.token).status !== 'failed'; i++) await wait();
    const status = jobs.status(link.id, link.token);
    assert.equal(status.status, 'failed'); assert.equal(status.completed, 0); assert.equal(status.hiddenWallets, 0);
    assert.equal(status.retainsPhrases, true);
    assert.match(status.error, /saved results and phrases are retained/i);
    const verify = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM retained_phrases WHERE job = ?').get(link.id).count, 1);
    verify.close();
  } finally {
    if (lock) { try { lock.exec('ROLLBACK'); lock.close(); } catch (_) {} }
    for (const release of waiting) release(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
