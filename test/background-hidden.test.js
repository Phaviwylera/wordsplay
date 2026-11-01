const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { Wallet } = require('ethers');
const { createBackgroundJobs } = require('../lib/background-jobs');

// Public test phrases only; never fund these accounts.
const phrases = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'test test test test test test test test test test test junk',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  'gravity machine north sort system female filter attitude volume fold club stay feature office ecology stable narrow fog',
];
const owners = phrases.map(value => Wallet.fromPhrase(value).address);
const networks = ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb'];
const native = { type: 'native', name: 'Native', symbol: 'ETH', rawBalance: '0', decimals: 18, price: null };
const busd = { type: 'BEP-20', name: 'BUSD', symbol: 'BUSD', contract: '0xe9e7cea3dedca5984780bafc599bd69add087d56', rawBalance: '0', decimals: 18, price: null };
const complete = (network, assets = [native]) => network === 'bnb' ? { coverage: 'bnb-and-busd', assets: [...assets, busd] } : { assets };
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, timeout = 10000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for EC2 job'); await wait(); }
}
async function finished(jobs, id, token) {
  await until(() => ['finished', 'failed'].includes(jobs.status(id, token)?.status));
  return jobs.status(id, token);
}

test('file jobs hide only fully checked zeros and preserve all checks through restore and retries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-hidden-'));
  let retry = false;
  const jobs = createBackgroundJobs(dir, { scan: async (address, network) => {
    const index = owners.indexOf(address);
    if (!retry && index === 3 && network === 'base') throw new Error('provider offline');
    if (!retry && index === 4 && network === 'bnb') return { coverage: 'native-only', assets: [native] };
    if (!retry && index === 5 && network === 'ethereum') return { assets: [{ ...native, rawBalance: null }] };
    const assets = [index === 1 && network === 'ethereum' ? { ...native, rawBalance: '1', decimals: 255 } : native];
    if (index === 2 && network === 'ethereum') assets.push({ type: 'ERC-721', name: 'Collectible', symbol: 'NFT', contract: '0x0000000000000000000000000000000000000001', rawBalance: '1', decimals: 0, price: null });
    return complete(network, assets);
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrases.join('\n')), { retainPhrases: true });
    const status = await finished(jobs, id, token);
    assert.equal(status.wallets, 6); assert.equal(status.total, 30); assert.equal(status.completed, 30);
    assert.equal(status.incomplete, 3); assert.equal(status.hiddenWallets, 1); assert.equal(status.visibleWallets, 5);
    const dashboard = jobs.dashboard(id, token);
    assert.equal(dashboard.assetCount, 2);
    assert.deepEqual(new Set(dashboard.walletPage.map(row => row.address)), new Set(owners.slice(1)));
    assert.equal(dashboard.walletPage.filter(row => row.incomplete).length, 3);
    assert.equal(jobs.results(id, token).checks.filter(row => row.address === owners[0]).length, 5, 'hidden checks remain stored');
    assert.equal(jobs.restoreHidden(id, '0'.repeat(64)), null);
    assert.equal(jobs.restoreHidden(id, token), 1);
    assert.equal(jobs.restoreHidden(id, token), 0);
    assert.equal(jobs.dashboard(id, token).walletPage.length, 6);
    retry = true;
    assert.equal(jobs.retry(id, token), true);
    const final = await finished(jobs, id, token);
    assert.equal(final.incomplete, 0); assert.equal(final.hiddenWallets, 3); assert.equal(final.visibleWallets, 3);
    const visible = new Set(jobs.dashboard(id, token).walletPage.map(row => row.address));
    assert.deepEqual(visible, new Set(owners.slice(0, 3)), 'manually restored wallets stay visible until their own checks run again');
    assert.equal(jobs.results(id, token).checks.length, 30);
    assert.equal(jobs.phrase(id, token, owners[0]), null, 'existing security policy still prunes unmatched file phrases');
    assert.equal(jobs.phrase(id, token, owners[1]), phrases[1]);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BNB refresh exposes pending hidden wallets and preserves newly positive or failed results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-hidden-refresh-'));
  let mode = 'zero'; let release;
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => {
    if (network === 'bnb' && mode === 'pending') return new Promise(resolve => { release = resolve; });
    if (network === 'bnb' && mode === 'fail') throw new Error('offline');
    return complete(network);
  } });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrases[0]), { retainPhrases: true });
    let status = await finished(jobs, id, token);
    assert.equal(status.hiddenWallets, 1); assert.equal(status.retainsPhrases, false);
    mode = 'pending'; assert.equal(jobs.refreshBnb(id, token), true);
    await until(() => Boolean(release));
    status = jobs.status(id, token);
    assert.equal(status.status, 'scanning'); assert.equal(status.hiddenWallets, 0); assert.equal(status.visibleWallets, 1);
    assert.equal(jobs.dashboard(id, token).walletPage.length, 1);
    const positiveBusd = { ...busd, rawBalance: '1' };
    release({ coverage: 'bnb-and-busd', assets: [native, positiveBusd] });
    status = await finished(jobs, id, token);
    assert.equal(status.hiddenWallets, 0); assert.equal(jobs.dashboard(id, token).assetCount, 1);
    assert.equal(jobs.phrase(id, token, owners[0]), null, 'a previously pruned phrase cannot be recovered by refresh');
    mode = 'fail'; assert.equal(jobs.refreshBnb(id, token), true);
    status = await finished(jobs, id, token);
    assert.equal(status.hiddenWallets, 0); assert.equal(status.incomplete, 1);
    const asset = jobs.dashboard(id, token).assets[0];
    assert.equal(asset.asset.rawBalance, '1'); assert.equal(asset.asset.stale, true); assert.equal(asset.status, 'partial');
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hidden and restored file state survives restart; inconsistent hidden checks are exposed on recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-hidden-restart-'));
  const scan = async (_address, network) => complete(network);
  let jobs = createBackgroundJobs(dir, { scan });
  try {
    const { id, token } = await jobs.receive(Readable.from(phrases[0]));
    await finished(jobs, id, token);
    assert.equal(jobs.status(id, token).hiddenWallets, 1);
    jobs.close(); jobs = createBackgroundJobs(dir, { scan });
    assert.equal(jobs.status(id, token).hiddenWallets, 1);
    assert.equal(jobs.restoreHidden(id, token), 1);
    jobs.close(); jobs = createBackgroundJobs(dir, { scan });
    assert.equal(jobs.status(id, token).visibleWallets, 1, 'one-time migration must not rehide restored entries');
    jobs.close();
    const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    db.prepare('UPDATE wallets SET hidden = 1 WHERE job = ?').run(id);
    db.prepare("UPDATE checks SET status = 'partial' WHERE job = ? AND network = 'base'").run(id);
    db.close();
    jobs = createBackgroundJobs(dir, { scan });
    assert.equal(jobs.status(id, token).hiddenWallets, 0);
    assert.equal(jobs.status(id, token).incomplete, 1);
    assert.equal(jobs.dashboard(id, token).walletPage.length, 1);
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy migration validates completed zero candidates and leaves malformed, stale and incomplete checks visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-hidden-legacy-'));
  const id = 'a'.repeat(64); const token = 'b'.repeat(64);
  const db = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT, iv TEXT, tag TEXT, lines INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE wallets (job TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY(job,address));
    CREATE TABLE checks (job TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, assets TEXT, reason TEXT, PRIMARY KEY(job,address,network));`);
  db.prepare("INSERT INTO jobs (id,token_hash,status,created_at) VALUES (?,?,'finished',?)").run(id, crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
  const addWallet = db.prepare('INSERT INTO wallets (job,address) VALUES (?,?)');
  const addCheck = db.prepare("INSERT INTO checks (job,address,network,status,assets) VALUES (?,?,?,'done',?)");
  for (let index = 0; index < 6; index++) {
    addWallet.run(id, owners[index]);
    for (const network of networks) {
      let assets = complete(network).assets;
      if ((index === 1 || index === 5) && network === 'base') assets = null; // malformed completed legacy row
      if (index === 2 && network === 'bnb') assets = [native]; // predates BUSD coverage
      if ((index === 3 || index === 5) && network === 'ethereum') assets = [{ ...native, rawBalance: '1' }];
      if (index === 4 && network === 'ethereum') assets = [{ ...native, stale: true }];
      addCheck.run(id, owners[index], network, JSON.stringify(assets));
    }
  }
  db.close();
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => complete(network) });
  try {
    let status = jobs.status(id, token);
    assert.equal(status.wallets, 6); assert.equal(status.hiddenWallets, 1); assert.equal(status.visibleWallets, 5);
    assert.equal(status.incomplete, 4);
    const visible = new Set(jobs.dashboard(id, token).walletPage.map(row => row.address));
    assert.deepEqual(visible, new Set(owners.slice(1)));
    assert.equal(jobs.dashboard(id, token).assetCount, 2);
    const checks = jobs.results(id, token).checks;
    const malformed = checks.find(row => row.address === owners[1] && row.network === 'base');
    assert.equal(malformed.status, 'partial'); assert.deepEqual(malformed.assets, []);
    assert.equal(checks.find(row => row.address === owners[5] && row.network === 'base').status, 'partial', 'positive wallets are validated too');
    assert.equal(jobs.retry(id, token), true);
    status = await finished(jobs, id, token);
    assert.equal(status.incomplete, 0); assert.equal(status.hiddenWallets, 4); assert.equal(status.visibleWallets, 2);
    assert.deepEqual(new Set(jobs.dashboard(id, token).walletPage.map(row => row.address)), new Set([owners[3], owners[5]]));
  } finally { jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
