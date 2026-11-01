const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { createBackgroundJobs } = require('../lib/background-jobs');
const { createFileJobRecovery, listenRecoveryControl, socketPath, CODE_TTL_MS } = require('../lib/file-job-recovery');
const { controlRequest } = require('../lib/recover-file-job');
const { BUSD_BSC } = require('../lib/prices');

const id = 'a'.repeat(64);
const id2 = 'b'.repeat(64);
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // Public test phrase; never fund.
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await wait(); }
  throw new Error('Timed out waiting for job');
}
function fakeJobs() {
  const tokens = new Map([[id, 'c'.repeat(64)], [id2, 'd'.repeat(64)]]);
  return { tokens,
    recoveryList: () => [...tokens.keys()].map(jobId => ({ id: jobId, status: 'scanning', createdAt: '2026-11-01T04:41:47.614Z' })),
    recoveryExists: jobId => tokens.has(jobId),
    rotateRecoveryToken: (jobId, token) => { if (!tokens.has(jobId)) return false; tokens.set(jobId, token); return true; },
  };
}

test('recovery codes are random, expiring, single-use, and rotate only the chosen token', () => {
  let now = 1000; const jobs = fakeJobs();
  const recovery = createFileJobRecovery(jobs, { now: () => now });
  assert.equal(recovery.issue('not-a-job'), null);
  assert.equal(recovery.issue('f'.repeat(64)), null);
  const first = recovery.issue(id); const replacement = recovery.issue(id);
  assert.match(first.code, /^[a-f0-9]{64}$/); assert.notEqual(first.code, replacement.code);
  assert.equal(recovery.redeem(first.code), null, 'issuing another code revokes the old one');
  assert.equal(jobs.tokens.get(id), 'c'.repeat(64), 'issuing alone does not change job access');
  const link = recovery.redeem(replacement.code);
  assert.equal(link.id, id); assert.match(link.token, /^[a-f0-9]{64}$/);
  assert.notEqual(link.token, 'c'.repeat(64)); assert.equal(jobs.tokens.get(id), link.token);
  assert.equal(jobs.tokens.get(id2), 'd'.repeat(64));
  assert.equal(recovery.redeem(replacement.code), null, 'a code cannot be replayed');
  assert.equal(recovery.redeem('0'.repeat(64)), null);
  assert.equal(recovery.redeem([replacement.code]), null, 'non-string input is never coerced into a code');
  assert.equal(recovery.issue([id2]), null);
  const expiring = recovery.issue(id2); now += CODE_TTL_MS;
  assert.equal(recovery.redeem(expiring.code), null);
  assert.equal(jobs.tokens.get(id2), 'd'.repeat(64), 'expiry does not rotate access');
  const deleted = recovery.issue(id2); jobs.tokens.delete(id2);
  assert.equal(recovery.redeem(deleted.code), null);
});

test('an active scan continues while recovery rotates its browser token in the same worker', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recover-active-'));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const jobs = createBackgroundJobs(dir, { scan: async (_address, network) => {
    await gate;
    const native = { type: 'native', symbol: network === 'bnb' ? 'BNB' : 'ETH', rawBalance: '1', decimals: 18, price: null };
    if (network === 'bnb') return { coverage: 'bnb-and-busd', assets: [native, { type: 'BEP-20', symbol: 'BUSD', contract: BUSD_BSC, rawBalance: '0', decimals: 18, price: null }] };
    return { assets: [native] };
  } });
  try {
    const previous = await jobs.receive(Readable.from(phrase), { retainPhrases: true });
    await until(() => jobs.status(previous.id, previous.token)?.status === 'scanning');
    const before = jobs.status(previous.id, previous.token);
    const recovery = createFileJobRecovery(jobs); const code = recovery.issue(previous.id).code;
    const link = recovery.redeem(code);
    assert.equal(jobs.authorized(previous.id, previous.token), false);
    assert.equal(jobs.authorized(link.id, link.token), true);
    const during = jobs.status(link.id, link.token);
    assert.equal(during.status, 'scanning'); assert.equal(during.wallets, before.wallets);
    assert.equal(during.total, before.total); assert.equal(during.completed, before.completed);
    release(); await until(() => jobs.status(link.id, link.token)?.status === 'finished');
    const after = jobs.status(link.id, link.token);
    assert.equal(after.completed, 5); assert.equal(after.incomplete, 0);
    assert.equal(after.retainsPhrases, true); assert.equal(jobs.matches(link.id, link.token).total, 1);
  } finally { release(); jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin control is a private socket, cannot be stolen from a live listener, and CLI issues the selected code', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recover-socket-'));
  const jobs = fakeJobs(); const recovery = createFileJobRecovery(jobs);
  let server;
  try {
    server = await listenRecoveryControl(dir, recovery);
    assert.equal(fs.statSync(path.join(dir, 'recovery-control')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(socketPath(dir)).mode & 0o777, 0o600);
    await assert.rejects(listenRecoveryControl(dir, recovery), /already in use/);
    assert.equal((await controlRequest(socketPath(dir), { action: 'list' })).jobs.length, 2, 'the original control socket still works');
    assert.deepEqual(await controlRequest(socketPath(dir), { action: 'unknown' }), { ok: false });
    const child = spawn(process.execPath, ['--no-warnings', 'lib/recover-file-job.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, WALLETO_BACKGROUND_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Choose a job number') && child.stdin.writable) child.stdin.end('1\n'); });
    child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, errors); assert.match(output, /2026-11-01T04:41:47\.614Z\s+scanning/);
    assert.doesNotMatch(output, new RegExp(id), 'the menu does not print a job identifier');
    const issued = output.match(/\n([a-f0-9]{64})\n/)?.[1]; assert.ok(issued);
    const link = recovery.redeem(issued); assert.equal(link.id, id); assert.equal(jobs.tokens.get(id), link.token);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery control refuses a symlinked control directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recover-dir-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recover-other-'));
  try {
    fs.symlinkSync(other, path.join(dir, 'recovery-control'));
    await assert.rejects(listenRecoveryControl(dir, createFileJobRecovery(fakeJobs())), /Invalid recovery control directory/);
    assert.deepEqual(fs.readdirSync(other), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('control socket recovers after an abruptly stopped worker, without deleting ordinary files', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-recover-stale-'));
  let server; let child;
  try {
    fs.mkdirSync(path.join(dir, 'recovery-control'), { mode: 0o700 });
    const filename = socketPath(dir);
    child = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1],()=>console.log('ready'))", filename], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('Socket child exited before starting')));
    });
    child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); child = null;
    assert.ok(fs.lstatSync(filename).isSocket(), 'abrupt stop leaves the Unix socket path');
    server = await listenRecoveryControl(dir, createFileJobRecovery(fakeJobs()));
    assert.equal((await controlRequest(filename, { action: 'list' })).ok, true);
    await new Promise(resolve => server.close(resolve)); server = null;
    fs.writeFileSync(filename, 'do not remove');
    await assert.rejects(listenRecoveryControl(dir, createFileJobRecovery(fakeJobs())), /already in use/);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'do not remove');
  } finally {
    if (child) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
