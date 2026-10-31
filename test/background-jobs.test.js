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
const { Wallet } = require('ethers');

// Public test phrase. Never fund this account.
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wait = () => new Promise(resolve => setTimeout(resolve, 40));
const fakeScan = async (_address, network) => ({ assets: [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '100', decimals: 18, price: null }], ...(network === 'bnb' ? { coverage: 'native-only' } : {}) });
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
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => ({
    assets: [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '0', decimals: 18, price: null }],
  }) });
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
    return { assets: [{ type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: balance, decimals: 18, price: null }] };
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
    const plan = migratedDb.prepare("EXPLAIN QUERY PLAN SELECT address,network FROM checks WHERE job = ? AND status = 'pending' LIMIT 1").all(id);
    assert.match(JSON.stringify(plan), /checks_pending_idx/);
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
    if (owner !== address || network !== 'ethereum') return { assets: [{ type: 'native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null }] };
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
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT address,network FROM checks WHERE job = ? AND has_positive = 1').all(id);
    assert.match(JSON.stringify(plan), /checks_positive_idx/);
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
    assert.equal(walletFirst.wallets, 107); assert.equal(walletFirst.walletPage.length, 100);
    assert.equal(walletLast.walletPage.length, 7);
    assert.equal(new Set([...walletFirst.walletPage, ...walletLast.walletPage].map(item => item.address)).size, 107);
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
    assert.equal(calls, 10); assert.ok(maxActive <= 6, `observed ${maxActive} concurrent provider checks`);
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
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM background_migrations').get().count, 1);
    migrated.close();
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
