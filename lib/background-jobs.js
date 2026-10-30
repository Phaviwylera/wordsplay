'use strict';

// EC2-only background work. The HTTP server must be published on loopback
// only and reached through an SSH tunnel; this module is not an auth server.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { Wallet, Mnemonic } = require('ethers');
const { scanWallet } = require('./scanner');

const NETWORKS = ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb'];
const tick = () => new Promise(resolve => setImmediate(resolve));
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');

function createBackgroundJobs(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'jobs.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT, iv TEXT, tag TEXT, lines INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS wallets (job TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (job,address));
    CREATE TABLE IF NOT EXISTS checks (job TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, assets TEXT, reason TEXT, PRIMARY KEY (job,address,network));`);
  const get = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const find = db.prepare('SELECT status, assets, reason FROM checks WHERE job = ? AND address = ? AND network = ?');
  const updateStatus = db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?');
  const addWallet = db.prepare('INSERT OR IGNORE INTO wallets (job,address) VALUES (?,?)');
  const addCheck = db.prepare("INSERT OR IGNORE INTO checks (job,address,network,status) VALUES (?,?,?,'pending')");
  const setCheck = db.prepare('UPDATE checks SET status = ?, assets = ?, reason = ? WHERE job = ? AND address = ? AND network = ?');
  const pending = db.prepare("SELECT address,network FROM checks WHERE job = ? AND status = 'pending' LIMIT 1");
  const summary = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('done','partial','failed') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status IN ('partial','failed') THEN 1 ELSE 0 END) AS incomplete FROM checks WHERE job = ?");
  const scan = options.scan || scanWallet;
  const active = new Set();
  let closed = false;

  const encryptedPath = id => path.join(directory, `${id}.upload`);
  function auth(id, token) {
    if (!/^[a-f0-9]{64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(token || '')) return null;
    const job = get.get(id);
    if (!job) return null;
    return crypto.timingSafeEqual(Buffer.from(job.token_hash, 'hex'), Buffer.from(digest(token), 'hex')) ? job : null;
  }
  function snapshot(job) {
    const counts = summary.get(job.id);
    const wallets = db.prepare('SELECT COUNT(*) AS count FROM wallets WHERE job = ?').get(job.id).count;
    return { id: job.id, status: job.status, createdAt: job.created_at, lines: job.lines, invalid: job.invalid, wallets, total: counts.total, completed: counts.completed || 0, incomplete: counts.incomplete || 0, error: job.error };
  }

  // Receiving is not resumable. Processing and scans can restart from the
  // encrypted upload and completed checks after an EC2/container restart.
  for (const job of db.prepare("SELECT id FROM jobs WHERE status = 'receiving'").all()) {
    try { fs.unlinkSync(encryptedPath(job.id)); } catch (_) {}
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  }
  db.prepare("UPDATE checks SET status = 'pending' WHERE status = 'running'").run();

  async function receive(stream) {
    const id = random(); const token = random();
    const key = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
    const filename = encryptedPath(id);
    db.prepare("INSERT INTO jobs (id,token_hash,status,created_at) VALUES (?,?,'receiving',?)").run(id, digest(token), new Date().toISOString());
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      await pipeline(stream, cipher, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      const tag = cipher.getAuthTag();
      db.prepare("UPDATE jobs SET status = 'importing', key = ?, iv = ?, tag = ? WHERE id = ?").run(key.toString('hex'), iv.toString('hex'), tag.toString('hex'), id);
      run(id);
      return { id, token };
    } catch (error) {
      try { await fsp.unlink(filename); } catch (_) {}
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      throw error;
    } finally { key.fill(0); }
  }

  async function importFile(job) {
    let line = ''; let tooLong = false; let lines = 0; let invalid = 0; let first = true;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(job.key, 'hex'), Buffer.from(job.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(job.tag, 'hex'));
    const source = fs.createReadStream(encryptedPath(job.id));
    source.on('error', error => decipher.destroy(error));
    const input = source.pipe(decipher);
    async function finishLine() {
      lines++;
      const text = line.trim();
      if (tooLong || text) {
        const phrase = tooLong ? '' : text.replace(/^[^:]{1,80}:\s*/, '').replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (phrase.length > 256 || !Mnemonic.isValidMnemonic(phrase)) invalid++;
        else {
          const address = Wallet.fromPhrase(phrase).address;
          addWallet.run(job.id, address);
          for (const network of NETWORKS) addCheck.run(job.id, address, network);
        }
      }
      line = ''; tooLong = false;
      if (lines % 20 === 0) {
        db.prepare('UPDATE jobs SET lines = ?, invalid = ? WHERE id = ?').run(lines, invalid, job.id);
        await tick();
      }
    }
    async function feed(text) {
      if (first) { first = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
      let start = 0;
      for (;;) {
        const end = text.indexOf('\n', start); const part = text.slice(start, end === -1 ? undefined : end);
        if (!tooLong) {
          line = (line + part).replace(/\s+/g, ' ').trimStart();
          if (line.trimEnd().length > 500) { line = ''; tooLong = true; }
        }
        if (end === -1) break;
        await finishLine(); start = end + 1;
      }
    }
    for await (const chunk of input) await feed(decoder.decode(chunk, { stream: true }));
    await feed(decoder.decode());
    if (line || tooLong) await finishLine();
    db.prepare("UPDATE jobs SET status = 'scanning', lines = ?, invalid = ?, key = NULL, iv = NULL, tag = NULL WHERE id = ?").run(lines, invalid, job.id);
    try { await fsp.unlink(encryptedPath(job.id)); } catch (_) { /* Cleanup can be retried by an operator. */ }
  }

  async function checkWorker(id) {
    while (!closed) {
      const task = pending.get(id);
      if (!task) return;
      db.prepare("UPDATE checks SET status = 'running' WHERE job = ? AND address = ? AND network = ?").run(id, task.address, task.network);
      try {
        const result = await scan(task.address, task.network);
        if (!Array.isArray(result.assets) || !result.assets.some(a => a?.type === 'native') || result.assets.some(a => typeof a?.rawBalance !== 'string' || !/^\d+$/.test(a.rawBalance))) throw new Error('Invalid scan result');
        const partial = result.coverage === 'native-only' && task.network !== 'bnb';
        setCheck.run(partial ? 'partial' : 'done', JSON.stringify(result.assets), partial ? 'Native only; token and NFT data unavailable' : null, id, task.address, task.network);
      } catch (_) { setCheck.run('failed', null, 'Provider unavailable or returned incomplete data', id, task.address, task.network); }
      await tick();
    }
  }
  async function run(id) {
    if (closed || active.has(id)) return;
    active.add(id);
    try {
      let job = get.get(id);
      if (!job) return;
      if (job.status === 'importing') await importFile(job);
      job = get.get(id);
      if (job?.status === 'scanning') {
        await Promise.all(Array.from({ length: 6 }, () => checkWorker(id)));
        if (!closed) updateStatus.run('finished', null, id);
      }
    } catch (_) {
      // Do not log exceptions from secret-bearing input or echo file content.
      updateStatus.run('failed', 'Could not process the UTF-8 file. No complete scan was recorded.', id);
      db.prepare('UPDATE jobs SET key = NULL, iv = NULL, tag = NULL WHERE id = ?').run(id);
      try { await fsp.unlink(encryptedPath(id)); } catch (_) {}
    } finally { active.delete(id); }
  }
  for (const job of db.prepare("SELECT id FROM jobs WHERE status IN ('importing','scanning')").all()) setImmediate(() => run(job.id));

  return {
    receive,
    status(id, token) { const job = auth(id, token); return job ? snapshot(job) : null; },
    results(id, token, offset = 0) {
      const job = auth(id, token); if (!job) return null;
      const parsed = Number(offset);
      const start = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
      const rows = db.prepare('SELECT address, network, status, assets, reason FROM checks WHERE job = ? ORDER BY address, network LIMIT 100 OFFSET ?').all(id, start);
      return { ...snapshot(job), offset: start, checks: rows.map(row => ({ ...row, assets: row.assets ? JSON.parse(row.assets) : [] })) };
    },
    retry(id, token) {
      const job = auth(id, token); if (!job || job.status !== 'finished' || active.has(id)) return false;
      db.prepare("UPDATE checks SET status = 'pending', assets = NULL, reason = NULL WHERE job = ? AND status IN ('failed','partial')").run(id);
      updateStatus.run('scanning', null, id); run(id); return true;
    },
    remove(id, token) {
      const job = auth(id, token); if (!job || active.has(id) || !['finished', 'failed'].includes(job.status)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM checks WHERE job = ?').run(id);
        db.prepare('DELETE FROM wallets WHERE job = ?').run(id);
        db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      try { fs.unlinkSync(encryptedPath(id)); } catch (_) {}
      return true;
    },
    close() { closed = true; if (!active.size) db.close(); },
  };
}
module.exports = { createBackgroundJobs };
