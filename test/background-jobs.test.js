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
  db.close();
  const jobs = createBackgroundJobs(dir, { scan: fakeScan });
  try {
    const status = jobs.status(id, token);
    assert.equal(status.phraseMatching, false);
    assert.equal(status.retainsPhrases, false);
    assert.equal(jobs.matches(id, token).enabled, false);
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
