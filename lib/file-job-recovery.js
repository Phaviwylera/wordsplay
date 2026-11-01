'use strict';

// Recovery codes are issued only over a private Unix socket inside the EC2
// container. The HTTP endpoint can redeem a code, but cannot issue or list
// one. The socket holder already has the same OS access as the job database.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CODES = 100;
const socketPath = directory => path.join(directory, 'recovery-control', 'recover.sock');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function createFileJobRecovery(jobs, { now = Date.now } = {}) {
  // Codes are short-lived, process-local and stored only as hashes. A restart
  // invalidates them, but does not change any job or existing job token.
  const pending = new Map();
  function prune() {
    const time = now();
    for (const [key, entry] of pending) if (entry.expiresAt <= time) pending.delete(key);
  }
  return {
    list() { return jobs.recoveryList(); },
    issue(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !jobs.recoveryExists(id)) return null;
      prune();
      // Only the latest code for a particular job can be redeemed.
      for (const [key, entry] of pending) if (entry.id === id) pending.delete(key);
      if (pending.size >= MAX_PENDING_CODES) return null;
      const code = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + CODE_TTL_MS;
      pending.set(hash(code), { id, expiresAt });
      return { code, expiresAt };
    },
    redeem(code) {
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return null;
      const key = hash(code);
      const entry = pending.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { pending.delete(key); return null; }
      const token = crypto.randomBytes(32).toString('hex');
      // This is done by the existing worker on its own SQLite connection, not
      // by a second worker or an external writer while a scan is active.
      if (!jobs.rotateRecoveryToken(entry.id, token)) { pending.delete(key); return null; }
      pending.delete(key);
      return { id: entry.id, token };
    },
  };
}

function isSocketActive(filename) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: filename });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Recovery socket probe timed out')); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

async function listenRecoveryControl(directory, recovery) {
  const controlDir = path.join(directory, 'recovery-control');
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(controlDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Invalid recovery control directory');
  fs.chmodSync(controlDir, 0o700);
  const filename = socketPath(directory);
  let stale;
  try { stale = fs.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stale) {
    if (!stale.isSocket() || await isSocketActive(filename)) throw new Error('Recovery socket is already in use');
    // Do not remove an unexpected file or a socket that changed during the probe.
    let current;
    try { current = fs.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current) {
      if (!current.isSocket() || current.dev !== stale.dev || current.ino !== stale.ino) throw new Error('Recovery socket changed');
      fs.unlinkSync(filename);
    }
  }
  const server = net.createServer(socket => {
    let input = ''; let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 2048) { handled = true; socket.destroy(); return; }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let response = { ok: false };
      try {
        const message = JSON.parse(input.slice(0, newline));
        if (message?.action === 'list') response = { ok: true, jobs: recovery.list() };
        else if (message?.action === 'issue') {
          const issued = recovery.issue(message.id);
          if (issued) response = { ok: true, ...issued };
        }
      } catch (_) { /* Do not log socket data or credentials. */ }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(filename, () => {
      try { fs.chmodSync(filename, 0o600); }
      catch (error) { server.close(); reject(error); return; }
      server.removeListener('error', failed);
      server.on('error', () => console.error('Private file-job recovery control is unavailable.'));
      resolve();
    });
  });
  return server;
}

module.exports = { CODE_TTL_MS, createFileJobRecovery, listenRecoveryControl, socketPath };
