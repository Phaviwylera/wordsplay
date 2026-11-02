'use strict';

// EC2-only background work. The HTTP server must be published on loopback
// only and reached through an SSH tunnel; this module is not an auth server.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { Wallet, Mnemonic } = require('ethers');
const { scanWallet } = require('./scanner');
const { BUSD_BSC, USDT_BSC, usdPrice, positive } = require('./prices');
const { inspectResult, mergeAssets } = require('./scan-result');
const { createScanQueue } = require('./scan-queue');
const { createAddressTools } = require('./addresses');
const { addressCsvRows, limitAddressCsvBytes, AddressCsvError } = require('./address-csv');
const { addressKeyRows, limitAddressKeyFileBytes, AddressKeyFileError } = require('./address-key-file');

const NETWORKS = ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb'];
const PUBLIC_NETWORKS = [...NETWORKS, 'bitcoin'];
const isAddressJob = kind => kind === 'addresses' || kind === 'address-keys';
const { classifyAddress } = createAddressTools(bytes => crypto.createHash('sha256').update(bytes).digest());
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// A target, not a promise: generation is slowed whenever providers cannot
// drain the bounded backlog. Each wallet needs five network checks.
const GENERATION_RATE = 100;
const GENERATION_BATCH = 10;
const MAX_GENERATED_BACKLOG = 2000; // network checks, not wallets
const GENERATION_DISK_INTERVAL = 5000;
const GENERATION_DISK_PAUSE = 'Generation is paused to protect free disk space and will resume when space is available.';
const digest = token => crypto.createHash('sha256').update(token).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');

// Read only well-formed saved components if a legacy row is corrupt. Its
// partial/failed status still prevents treating missing data as a zero result.
function savedAssets(json) {
  try {
    const assets = JSON.parse(json);
    if (!Array.isArray(assets)) return [];
    return assets.filter(asset => asset && typeof asset.rawBalance === 'string' && /^\d+$/.test(asset.rawBalance)
      && asset.rawBalance.replace(/^0+/, '').length <= 78
      && ((typeof asset.decimals === 'number' && Number.isInteger(asset.decimals)) || (typeof asset.decimals === 'string' && /^\d+$/.test(asset.decimals)))
      && Number(asset.decimals) >= 0 && Number(asset.decimals) <= 255);
  } catch (_) { return []; }
}

function createBackgroundJobs(directory, options = {}) {
  // Internal override makes the disk-pause recovery interval deterministic in
  // tests; production rechecks every five seconds.
  const diskCheckInterval = options.generationDiskCheckInterval ?? GENERATION_DISK_INTERVAL;
  if (!Number.isInteger(diskCheckInterval) || diskCheckInterval < 1) throw new Error('Invalid generation disk-check interval');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'jobs.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, key TEXT, iv TEXT, tag TEXT, lines INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS wallets (job TEXT NOT NULL, address TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job,address));
    CREATE TABLE IF NOT EXISTS checks (job TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL, status TEXT NOT NULL, assets TEXT, reason TEXT, PRIMARY KEY (job,address,network));
    CREATE TABLE IF NOT EXISTS retained_phrases (job TEXT NOT NULL, address TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, ciphertext TEXT NOT NULL, PRIMARY KEY(job,address));`);
  // Old jobs remain readable and keep their original no-retention behavior.
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'phrase_key')) db.exec('ALTER TABLE jobs ADD COLUMN phrase_key TEXT');
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'retain_phrases')) db.exec('ALTER TABLE jobs ADD COLUMN retain_phrases INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'kind')) db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload'");
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(column => column.name));
  for (const [name, definition] of [
    ['generation_active', 'INTEGER NOT NULL DEFAULT 0'], ['generation_reason', 'TEXT'],
    ['generated_count', 'INTEGER NOT NULL DEFAULT 0'], ['generated_completed', 'INTEGER NOT NULL DEFAULT 0'],
    ['generated_incomplete', 'INTEGER NOT NULL DEFAULT 0'], ['upload_request_hash', 'TEXT'],
  ]) if (!jobColumns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_upload_request_idx ON jobs (upload_request_hash) WHERE upload_request_hash IS NOT NULL');
  if (!db.prepare('PRAGMA table_info(checks)').all().some(column => column.name === 'has_positive')) db.exec('ALTER TABLE checks ADD COLUMN has_positive INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(checks)').all().some(column => column.name === 'positive_at')) db.exec('ALTER TABLE checks ADD COLUMN positive_at INTEGER');
  if (!db.prepare('PRAGMA table_info(wallets)').all().some(column => column.name === 'hidden')) db.exec('ALTER TABLE wallets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  // Earlier versions added has_positive with a zero default but did not fill it
  // for existing checks. Repair those jobs once, even if the column already
  // exists, so their positive assets remain visible in the main dashboard.
  db.exec('CREATE TABLE IF NOT EXISTS background_migrations (name TEXT PRIMARY KEY)');
  if (!db.prepare('SELECT 1 FROM background_migrations WHERE name = ?').get('backfill-positive-assets-v1')) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        UPDATE checks SET has_positive = 1 WHERE has_positive = 0 AND assets IS NOT NULL AND
          CASE WHEN json_valid(assets) THEN CASE WHEN json_type(assets) = 'array' THEN EXISTS (
            SELECT 1 FROM json_each(assets) a
            WHERE length(ltrim(json_extract(assets, '$[' || a.key || '].rawBalance'), '0')) > 0
          ) ELSE 0 END ELSE 0 END;
        INSERT INTO background_migrations (name) VALUES ('backfill-positive-assets-v1');
        COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  // Old completed BNB checks did not look for BUSD. Mark them incomplete once
  // rather than silently presenting a native-only scan as complete. Keep their
  // balances and any retained phrases until the user retries on EC2.
  if (!db.prepare('SELECT 1 FROM background_migrations WHERE name = ?').get('bnb-busd-coverage-v1')) {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE checks SET status = 'partial', reason = 'BUSD was not checked by the previous version; retry this check.'
        WHERE network = 'bnb' AND status = 'done' AND NOT CASE WHEN json_valid(assets) THEN CASE WHEN json_type(assets) = 'array' THEN EXISTS (
          SELECT 1 FROM json_each(assets) a WHERE lower(json_extract(assets, '$[' || a.key || '].contract')) = ?
        ) ELSE 0 END ELSE 0 END`).run(BUSD_BSC);
      db.prepare('INSERT INTO background_migrations (name) VALUES (?)').run('bnb-busd-coverage-v1');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  // Upgrade previously completed BNB checks that verified BUSD but did not
  // yet query USDT. Preserve saved assets and phrases while making the check
  // retryable so the next scan verifies both canonical stablecoins.
  if (!db.prepare('SELECT 1 FROM background_migrations WHERE name = ?').get('bnb-usdt-coverage-v1')) {
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE checks SET status = 'partial', reason = 'USDT was not checked by the previous version; retry this check.'
        WHERE network = 'bnb' AND status = 'done' AND NOT CASE WHEN json_valid(assets) THEN CASE WHEN json_type(assets) = 'array' THEN EXISTS (
          SELECT 1 FROM json_each(assets) a WHERE lower(json_extract(assets, '$[' || a.key || '].contract')) = ?
        ) ELSE 0 END ELSE 0 END`).run(USDT_BSC);
      db.prepare('INSERT INTO background_migrations (name) VALUES (?)').run('bnb-usdt-coverage-v1');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  // A wallet is hidden only after every expected network check is complete and
  // every checked asset has a verified zero balance. Records are never deleted.
  const expectedNetworks = NETWORKS.map(network => `'${network}'`).join(',');
  const verifiedZero = `(
    (substr(wallets.address, 1, 2) = '0x'
      AND (SELECT COUNT(*) FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address) = ${NETWORKS.length}
      AND (SELECT COUNT(*) FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address
        AND c.network IN (${expectedNetworks}) AND c.status = 'done' AND c.has_positive = 0) = ${NETWORKS.length})
    OR ((substr(lower(wallets.address), 1, 3) = 'bc1' OR substr(wallets.address, 1, 1) IN ('1', '3'))
      AND (SELECT COUNT(*) FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address) = 1
      AND EXISTS (SELECT 1 FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address
        AND c.network = 'bitcoin' AND c.status = 'done' AND c.has_positive = 0))
  )`;
  // Validate every legacy completed check, including those on currently
  // positive wallets. Otherwise a later refresh could clear that positive and
  // hide a wallet despite a malformed older check on a different network.
  // BNB checks without BUSD have already been marked partial above.
  if (!db.prepare('SELECT 1 FROM background_migrations WHERE name = ?').get('hide-zero-wallets-v1')) {
    const legacyChecks = db.prepare("SELECT job,address,network,assets FROM checks WHERE status = 'done' ORDER BY job,address,network");
    const legacyInvalid = db.prepare("UPDATE checks SET status = 'partial', reason = 'Saved check could not be verified; retry.' WHERE job = ? AND address = ? AND network = ?");
    const legacyPositive = db.prepare('UPDATE checks SET has_positive = 1 WHERE job = ? AND address = ? AND network = ?');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const check of legacyChecks.iterate()) {
        if (savedAssets(check.assets).some(asset => BigInt(asset.rawBalance) > 0n)) legacyPositive.run(check.job, check.address, check.network);
        try {
          const assets = JSON.parse(check.assets);
          const coverage = inspectResult({ assets }, check.network, check.address);
          if (coverage.partial || assets.some(asset => Boolean(asset.stale))) throw new Error('Incomplete saved check');
        } catch (_) { legacyInvalid.run(check.job, check.address, check.network); }
      }
      db.exec(`UPDATE wallets SET hidden = 1 WHERE ${verifiedZero}
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = wallets.job AND j.status IN ('finished','scanning'))`);
      db.prepare('INSERT INTO background_migrations (name) VALUES (?)').run('hide-zero-wallets-v1');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  // Populate counters only for legacy generated jobs; never rewrite or count
  // the user's large uploaded jobs during this migration.
  if (!db.prepare('SELECT 1 FROM background_migrations WHERE name = ?').get('generated-counters-v1')) {
    try {
      db.exec(`BEGIN IMMEDIATE;
        UPDATE jobs SET
          generated_count = (SELECT COUNT(*) FROM wallets w WHERE w.job = jobs.id),
          generated_completed = (SELECT COUNT(*) FROM checks c WHERE c.job = jobs.id AND c.status IN ('done','partial','failed')),
          generated_incomplete = (SELECT COUNT(*) FROM checks c WHERE c.job = jobs.id AND c.status IN ('partial','failed'))
        WHERE kind = 'generated';
        INSERT INTO background_migrations (name) VALUES ('generated-counters-v1'); COMMIT;`);
    } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  // The worker repeatedly claims the first pending check. Without this partial
  // index, a large job rescans all earlier completed rows for every claim.
  db.exec("CREATE INDEX IF NOT EXISTS checks_pending_idx ON checks (job,address,network) WHERE status = 'pending'");
  db.exec('CREATE INDEX IF NOT EXISTS wallets_visibility_idx ON wallets (job,hidden,address)');
  db.exec("CREATE INDEX IF NOT EXISTS checks_pending_network_idx ON checks (job,network,address) WHERE status = 'pending'");
  db.exec('CREATE INDEX IF NOT EXISTS checks_positive_idx ON checks (job,address,network) WHERE has_positive = 1');
  // Find recent positive checks without sorting every wallet in a large job.
  // Legacy positive rows remain visible with a null timestamp.
  db.exec('CREATE INDEX IF NOT EXISTS checks_recent_positive_idx ON checks (job,positive_at DESC,address,network) WHERE has_positive = 1');
  // Price only valid fungible assets. The same formatting rules are used by the
  // watch-only dashboard; values are approximate, not accounting figures.
  db.function('walleto_asset_value', { deterministic: true }, (json, network, bnb, busd, usdt, btc, eth) => {
    try {
      const asset = JSON.parse(json);
      const price = usdPrice(asset, network, { bnb, busd, usdt, btc, eth });
      if (price === null || typeof asset.rawBalance !== 'string' || !/^\d+$/.test(asset.rawBalance) || !((typeof asset.decimals === 'number' && Number.isInteger(asset.decimals)) || (typeof asset.decimals === 'string' && /^\d+$/.test(asset.decimals))) || Number(asset.decimals) < 0 || Number(asset.decimals) > 255) return null;
      const places = Number(asset.decimals);
      const digits = BigInt(asset.rawBalance).toString().padStart(places + 1, '0');
      const balance = Number(places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits);
      const value = balance * price;
      return Number.isFinite(value) ? value : null;
    } catch (_) { return null; }
  });
  const get = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const find = db.prepare('SELECT status, assets, reason, has_positive FROM checks WHERE job = ? AND address = ? AND network = ?');
  const updateStatus = db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?');
  const addWallet = db.prepare('INSERT OR IGNORE INTO wallets (job,address) VALUES (?,?)');
  const addCheck = db.prepare("INSERT OR IGNORE INTO checks (job,address,network,status) VALUES (?,?,?,'pending')");
  const setCheck = db.prepare('UPDATE checks SET status = ?, assets = ?, reason = ?, has_positive = ?, positive_at = ? WHERE job = ? AND address = ? AND network = ?');
  const addPhrase = db.prepare('INSERT OR IGNORE INTO retained_phrases (job,address,iv,tag,ciphertext) VALUES (?,?,?,?,?)');
  const pending = db.prepare("SELECT address,network FROM checks WHERE job = ? AND network = ? AND status = 'pending' ORDER BY address LIMIT 1");
  const updateVisibility = db.prepare(`UPDATE wallets SET hidden = CASE WHEN ${verifiedZero} THEN 1 ELSE 0 END WHERE job = ? AND address = ?`);
  function commitCheck(status, assets, reason, hasPositive, id, address, network) {
    db.exec('BEGIN IMMEDIATE');
    try {
      setCheck.run(status, assets, reason, hasPositive, hasPositive ? Date.now() : null, id, address, network);
      updateVisibility.run(id, address);
      if (get.get(id)?.kind === 'generated') {
        db.prepare('UPDATE jobs SET generated_completed = generated_completed + 1, generated_incomplete = generated_incomplete + ? WHERE id = ?')
          .run(['partial', 'failed'].includes(status) ? 1 : 0, id);
        // A continuous job might never reach a global finish. Once this wallet
        // alone is fully verified zero, its phrase can follow the existing
        // zero-result pruning policy without waiting for unrelated wallets.
        db.prepare(`DELETE FROM retained_phrases WHERE job = ? AND address = ?
          AND EXISTS (SELECT 1 FROM wallets w WHERE w.job = ? AND w.address = ? AND w.hidden = 1)`)
          .run(id, address, id, address);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const summary = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('done','partial','failed') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status IN ('partial','failed') THEN 1 ELSE 0 END) AS incomplete FROM checks WHERE job = ?");
  const scan = options.scan || scanWallet;
  const active = new Set();
  const generationWorkers = new Set();
  let closed = false; let dbClosed = false;
  function closeDatabase() { if (!dbClosed) { dbClosed = true; db.close(); } }
  async function waitWhileOpen(ms, signal) {
    const until = Date.now() + ms;
    while (!closed && !signal.aborted && Date.now() < until) await delay(Math.min(250, Math.max(1, until - Date.now())));
  }
  const hasActiveGenerator = db.prepare("SELECT 1 FROM jobs WHERE kind = 'generated' AND generation_active = 1 AND status = 'scanning' LIMIT 1");
  const perNetwork = options.perNetworkConcurrency ?? 6;
  // All jobs share this queue. Thirty-two concurrent checks, with at most six
  // per network, raise throughput while retaining provider-specific caps.
  const scanQueue = createScanQueue({ concurrency: options.concurrency ?? 32, perNetwork });
  const boundedScan = (address, network, signal) => scanQueue.run(network, () => scan(address, network), signal);

  const encryptedPath = id => path.join(directory, `${id}.upload`);
  function auth(id, token) {
    if (!/^[a-f0-9]{64}$/.test(id || '') || !/^[a-f0-9]{64}$/.test(token || '')) return null;
    const job = get.get(id);
    if (!job) return null;
    return crypto.timingSafeEqual(Buffer.from(job.token_hash, 'hex'), Buffer.from(digest(token), 'hex')) ? job : null;
  }
  function encryptPhrase(job, address, phrase) {
    const key = Buffer.from(job.phrase_key, 'hex');
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${job.id}:${address}`));
      const ciphertext = Buffer.concat([cipher.update(phrase, 'utf8'), cipher.final()]);
      addPhrase.run(job.id, address, iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex'));
    } finally { key.fill(0); }
  }
  function decryptPhrase(job, row) {
    const key = Buffer.from(job.phrase_key, 'hex');
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex'));
      cipher.setAAD(Buffer.from(`${job.id}:${row.address}`));
      cipher.setAuthTag(Buffer.from(row.tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(row.ciphertext, 'hex')), cipher.final()]).toString('utf8');
    } finally { key.fill(0); }
  }
  function snapshot(job) {
    const generated = job.kind === 'generated';
    const counts = generated ? { total: job.generated_count * NETWORKS.length, completed: job.generated_completed, incomplete: job.generated_incomplete } : summary.get(job.id);
    const walletCounts = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(hidden), 0) AS hidden FROM wallets WHERE job = ?').get(job.id);
    return { id: job.id, status: job.status, kind: generated ? 'generated' : isAddressJob(job.kind) ? 'addresses' : 'upload', createdAt: job.created_at, lines: job.lines, invalid: job.invalid, wallets: walletCounts.count, visibleWallets: walletCounts.count - walletCounts.hidden, hiddenWallets: walletCounts.hidden, total: counts.total, completed: counts.completed || 0, incomplete: counts.incomplete || 0, error: job.error, phraseMatching: Boolean(job.retain_phrases), retainsPhrases: Boolean(job.phrase_key),
      ...(generated ? { generationActive: Boolean(job.generation_active), generationReason: job.generation_reason, generationTarget: GENERATION_RATE } : {}),
      ...(isAddressJob(job.kind) ? { addressFormat: job.kind === 'address-keys' ? 'key-pairs' : 'csv', hasBnbChecks: Boolean(db.prepare("SELECT 1 FROM wallets WHERE job = ? AND address >= '0x' AND address < '0y' LIMIT 1").get(job.id)) } : {}) };
  }

  // Receiving is not resumable. Processing and scans can restart from the
  // encrypted upload and completed checks after an EC2/container restart.
  for (const job of db.prepare("SELECT id FROM jobs WHERE status = 'receiving'").all()) {
    try { fs.unlinkSync(encryptedPath(job.id)); } catch (_) {}
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  }
  db.prepare("UPDATE checks SET status = 'pending' WHERE status = 'running'").run();
  // A crash or older database must never leave pending, failed or positive
  // wallets hidden; a later successful check may hide them again.
  db.exec(`UPDATE wallets SET hidden = 0 WHERE hidden = 1 AND NOT (${verifiedZero})`);

  async function receive(stream, { retainPhrases = false, kind = 'upload', requestId } = {}) {
    if (!['upload', 'generated', 'addresses', 'address-keys'].includes(kind) || (isAddressJob(kind) && retainPhrases)) throw new Error('Invalid job kind');
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId))) throw new Error('Invalid upload request ID');
    const uploadHash = requestId ? digest(requestId) : null;
    let id; let token; let key; let iv; let phraseKey; let filename;
    try {
      db.exec('BEGIN IMMEDIATE');
      if (uploadHash) {
        const existing = db.prepare('SELECT id,kind,status FROM jobs WHERE upload_request_hash = ?').get(uploadHash);
        if (existing) {
          db.exec('COMMIT'); stream.resume();
          if (existing.kind !== kind) throw Object.assign(new Error('Upload request ID is already linked to a different file type.'), { code: 'UPLOAD_ID_CONFLICT' });
          return existing.status === 'receiving'
            ? { pending: true, status: 'receiving' }
            : { id: existing.id, token: requestId, ...(isAddressJob(existing.kind) ? { kind: 'addresses' } : {}), status: existing.status };
        }
      }
      id = random(); token = requestId || random();
      key = crypto.randomBytes(32); iv = crypto.randomBytes(12);
      phraseKey = retainPhrases ? crypto.randomBytes(32) : null;
      filename = encryptedPath(id);
      db.prepare("INSERT INTO jobs (id,token_hash,status,created_at,retain_phrases,kind,upload_request_hash) VALUES (?,?,'receiving',?,?,?,?)").run(id, digest(token), new Date().toISOString(), retainPhrases ? 1 : 0, kind, uploadHash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      key?.fill(0); phraseKey?.fill(0); stream.resume(); throw error;
    }
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const limit = kind === 'addresses' ? [limitAddressCsvBytes()] : kind === 'address-keys' ? [limitAddressKeyFileBytes()] : [];
      await pipeline(stream, ...limit, cipher, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      const tag = cipher.getAuthTag();
      db.prepare("UPDATE jobs SET status = 'importing', key = ?, iv = ?, tag = ?, phrase_key = ? WHERE id = ?").run(key.toString('hex'), iv.toString('hex'), tag.toString('hex'), phraseKey?.toString('hex') || null, id);
      run(id);
      return isAddressJob(kind) ? { id, token, kind: 'addresses' } : { id, token };
    } catch (error) {
      try { await fsp.unlink(filename); } catch (_) {}
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      throw error;
    } finally { key.fill(0); phraseKey?.fill(0); }
  }

  // One durable job receives a continuous stream rather than creating a job
  // per phrase. No plaintext .txt file or browser round-trip is involved.
  function generate() {
    if (closed || hasActiveGenerator.get()) return null;
    const id = random(); const token = random(); const key = crypto.randomBytes(32);
    try {
      db.prepare(`INSERT INTO jobs (id,token_hash,status,created_at,retain_phrases,phrase_key,kind,generation_active)
        VALUES (?,?,'scanning',?,1,?,'generated',1)`).run(id, digest(token), new Date().toISOString(), key.toString('hex'));
    } finally { key.fill(0); }
    run(id);
    return { id, token, kind: 'generated' };
  }

  function batchWorker() {
    const worker = new Worker(path.join(__dirname, 'generation-worker.js'));
    generationWorkers.add(worker);
    let pending = null;
    function fail() { if (pending) { const call = pending; pending = null; call.reject(new Error('Generation worker stopped')); } }
    worker.on('error', fail); worker.on('exit', fail);
    worker.on('message', message => {
      if (!pending) return;
      const call = pending; pending = null;
      if (message?.error || !Array.isArray(message?.batch)) call.reject(new Error('Generation worker failed'));
      else call.resolve(message.batch);
    });
    return {
      batch(count) { return new Promise((resolve, reject) => { pending = { resolve, reject }; worker.postMessage(count); }); },
      async close() { generationWorkers.delete(worker); await worker.terminate(); },
    };
  }

  function diskHasRoom() {
    const stats = fs.statfsSync(directory);
    const available = Number(stats.bavail) * Number(stats.bsize);
    const total = Number(stats.blocks) * Number(stats.bsize);
    return available > Math.max(2 * 1024 ** 3, total * 0.2);
  }

  async function generateContinuously(id, signal) {
    const rate = options.generationRate ?? GENERATION_RATE;
    const batchSize = options.generationBatchSize ?? GENERATION_BATCH;
    const maxBacklog = options.generationMaxBacklog ?? MAX_GENERATED_BACKLOG;
    let worker; let lastDiskCheck = 0; let pausedForDisk = false;
    try {
      if (!Number.isInteger(rate) || rate < 1 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 || !Number.isInteger(maxBacklog) || maxBacklog < NETWORKS.length) throw new Error('Invalid generation limits');
      if (!closed && !signal.aborted && !options.generateBatch) worker = batchWorker();
      while (!closed && !signal.aborted) {
        const job = get.get(id);
        if (!job || !job.generation_active) break;
        const now = Date.now();
        if (now - lastDiskCheck >= diskCheckInterval || pausedForDisk) {
          lastDiskCheck = now;
          if (!(options.generationDiskAvailable || diskHasRoom)()) {
            if (!pausedForDisk) db.prepare('UPDATE jobs SET generation_reason = ? WHERE id = ?').run(GENERATION_DISK_PAUSE, id);
            pausedForDisk = true;
            await waitWhileOpen(diskCheckInterval, signal);
            continue;
          }
          // Clear a persisted pause reason after either a live recovery or a
          // process restart that finds free space already restored.
          if (pausedForDisk || job.generation_reason === GENERATION_DISK_PAUSE) {
            db.prepare('UPDATE jobs SET generation_reason = NULL WHERE id = ? AND generation_reason = ?').run(id, GENERATION_DISK_PAUSE);
          }
          pausedForDisk = false;
        }
        const remaining = maxBacklog - (job.generated_count * NETWORKS.length - job.generated_completed);
        if (remaining < NETWORKS.length) { await delay(100); continue; }
        const count = Math.min(batchSize, Math.floor(remaining / NETWORKS.length));
        const started = Date.now();
        const batch = await (options.generateBatch ? options.generateBatch(count) : worker.batch(count));
        if (closed || signal.aborted || !get.get(id)?.generation_active) break;
        if (!Array.isArray(batch) || batch.length !== count) throw new Error('Invalid generated batch');
        db.exec('BEGIN IMMEDIATE');
        try {
          let added = 0;
          for (const item of batch) {
            if (!item || typeof item.address !== 'string' || !/^0x[\da-f]{40}$/i.test(item.address) || typeof item.phrase !== 'string' || item.phrase.trim().split(/\s+/).length !== 12 || !Mnemonic.isValidMnemonic(item.phrase)) throw new Error('Invalid generated combination');
            if (!addWallet.run(id, item.address).changes) continue;
            encryptPhrase(job, item.address, item.phrase);
            for (const network of NETWORKS) addCheck.run(id, item.address, network);
            added++;
          }
          db.prepare('UPDATE jobs SET generated_count = generated_count + ?, lines = lines + ? WHERE id = ?').run(added, added, id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        // Never exceed the 100/s target, and yield while providers catch up.
        const interval = Math.ceil(count * 1000 / rate);
        await delay(Math.max(1, interval - (Date.now() - started)));
      }
    } catch (_) {
      if (!closed && !signal.aborted) db.prepare("UPDATE jobs SET generation_active = 0, generation_reason = 'Automatic generation stopped due to a server error.' WHERE id = ?").run(id);
    } finally { if (worker) await worker.close(); }
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
          const added = addWallet.run(job.id, address).changes;
          if (added && job.kind === 'generated') db.prepare('UPDATE jobs SET generated_count = generated_count + 1 WHERE id = ?').run(job.id);
          if (job.phrase_key) encryptPhrase(job, address, phrase);
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

  async function importAddressKeyFile(job) {
    let lines = 0; let invalid = 0; let valid = 0;
    const key = Buffer.from(job.key, 'hex');
    let source; let input;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(job.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(job.tag, 'hex'));
      source = fs.createReadStream(encryptedPath(job.id));
      source.on('error', error => decipher.destroy(error));
      input = source.pipe(decipher);
      for await (const row of addressKeyRows(input)) {
        if (row.header) continue;
        lines++;
        if (row.invalid || !/^0x[\da-f]{40}$/i.test(row.address || '') || !/^(?:0x)?[\da-f]{64}$/i.test(row.privateKey || '')) {
          invalid++;
        } else {
          let derived = null;
          try {
            const privateKey = /^0x/i.test(row.privateKey) ? row.privateKey : `0x${row.privateKey}`;
            derived = new Wallet(privateKey).address;
          } catch (_) { /* Invalid private-key material is counted, never echoed. */ }
          if (!derived || derived.toLowerCase() !== row.address.toLowerCase()) invalid++;
          else {
            valid++;
            addWallet.run(job.id, derived);
            for (const network of NETWORKS) addCheck.run(job.id, derived, network);
          }
        }
        if (row.privateKey !== undefined) row.privateKey = '';
        if (row.address !== undefined) row.address = '';
        if (lines % 100 === 0) {
          db.prepare('UPDATE jobs SET lines = ?, invalid = ? WHERE id = ?').run(lines, invalid, job.id);
          await tick();
        }
      }
      if (!valid) throw new AddressKeyFileError('NO_ADDRESSES');
      db.prepare("UPDATE jobs SET status = 'scanning', lines = ?, invalid = ?, key = NULL, iv = NULL, tag = NULL WHERE id = ?").run(lines, invalid, job.id);
      job.key = null; job.iv = null; job.tag = null;
      try { await fsp.unlink(encryptedPath(job.id)); } catch (_) { /* The key is no longer available from the database. */ }
    } catch (error) {
      db.prepare('UPDATE jobs SET lines = ?, invalid = ?, key = NULL, iv = NULL, tag = NULL WHERE id = ?').run(lines, invalid, job.id);
      db.prepare('DELETE FROM checks WHERE job = ?').run(job.id);
      db.prepare('DELETE FROM wallets WHERE job = ?').run(job.id);
      try { await fsp.unlink(encryptedPath(job.id)); } catch (_) {}
      job.key = null; job.iv = null; job.tag = null;
      throw error instanceof AddressKeyFileError ? error : new AddressKeyFileError('READ');
    } finally {
      key.fill(0);
      if (source) source.destroy();
    }
  }

  async function importAddressCsv(job) {
    let lines = 0; let invalid = 0; let batch = [];
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(job.key, 'hex'), Buffer.from(job.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(job.tag, 'hex'));
    const source = fs.createReadStream(encryptedPath(job.id));
    source.on('error', error => decipher.destroy(error));
    const input = source.pipe(decipher);
    async function flush() {
      if (!batch.length) return;
      // Keep each batch atomic and never yield while the SQLite transaction is
      // open. Replaying the encrypted file after a restart is idempotent.
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const cells of batch) {
          lines++;
          for (const { value, family } of cells) {
            if (!value) continue;
            const info = classifyAddress(value);
            if (!info || (family && family !== info.family)) { invalid++; continue; }
            addWallet.run(job.id, info.key);
            for (const network of info.family === 'bitcoin' ? ['bitcoin'] : NETWORKS) addCheck.run(job.id, info.key, network);
          }
        }
        db.prepare('UPDATE jobs SET lines = ?, invalid = ? WHERE id = ?').run(lines, invalid, job.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      batch = []; await tick();
    }
    try {
      for await (const cells of addressCsvRows(input)) {
        batch.push(cells);
        if (batch.length >= 100) await flush();
      }
      await flush();
      if (!db.prepare('SELECT 1 FROM wallets WHERE job = ? LIMIT 1').get(job.id)) throw new AddressCsvError('NO_ADDRESSES');
      db.prepare("UPDATE jobs SET status = 'scanning', lines = ?, invalid = ?, key = NULL, iv = NULL, tag = NULL WHERE id = ?").run(lines, invalid, job.id);
      try { await fsp.unlink(encryptedPath(job.id)); } catch (_) { /* Cleanup can be retried by an operator. */ }
    } finally { source.destroy(); }
  }

  function pruneUnmatchedPhrases(id) {
    // Keep unmatched phrases while any network check is incomplete so a later
    // retry can still associate newly discovered balances with their phrase.
    if ((summary.get(id).incomplete || 0) > 0) return;
    db.prepare(`DELETE FROM retained_phrases
      WHERE job = ? AND NOT EXISTS (
        SELECT 1 FROM checks
        WHERE checks.job = retained_phrases.job
          AND checks.address = retained_phrases.address
          AND checks.has_positive = 1
      )`).run(id);
    if (!db.prepare('SELECT 1 FROM retained_phrases WHERE job = ? LIMIT 1').get(id)) {
      db.prepare('UPDATE jobs SET phrase_key = NULL WHERE id = ?').run(id);
    }
  }

  async function checkWorker(id, network, signal) {
    while (!closed && !signal.aborted) {
      const task = pending.get(id, network);
      if (!task) {
        const job = get.get(id);
        if (job?.kind === 'generated' && job.generation_active) { await delay(100); continue; }
        return;
      }
      const previous = find.get(id, task.address, task.network);
      db.prepare("UPDATE checks SET status = 'running' WHERE job = ? AND address = ? AND network = ?").run(id, task.address, task.network);
      try {
        const result = await boundedScan(task.address, task.network, signal);
        if (closed || signal.aborted) return;
        const coverage = inspectResult(result, task.network, task.address);
        const earlier = savedAssets(previous?.assets);
        // Persist an explicit freshness flag so legacy partial results, which
        // lack one, can be conservatively labelled as previous in the UI.
        const assets = mergeAssets(earlier, result.assets, coverage).map(asset => ({ ...asset, stale: Boolean(asset.stale) }));
        const hasPositive = assets.some(asset => BigInt(asset.rawBalance) > 0n);
        const reason = coverage.partial ? (!coverage.native ? 'Native balance unavailable; token results may be available.' : task.network === 'bnb' ? 'BUSD/USDT checks unavailable; retry.' : 'Token and NFT data unavailable; retry.') : null;
        commitCheck(coverage.partial ? 'partial' : 'done', JSON.stringify(assets), reason, hasPositive ? 1 : 0, id, task.address, task.network);
      } catch (_) {
        if (closed || signal.aborted) return;
        if (previous?.assets) {
          let retained = previous.assets;
          try { retained = JSON.stringify(JSON.parse(previous.assets).map(asset => ({ ...asset, stale: true }))); } catch (_) { /* Preserve legacy data as-is. */ }
          commitCheck('partial', retained, 'Refresh failed; previous balances shown.', previous.has_positive, id, task.address, task.network);
        } else commitCheck('failed', null, 'Provider unavailable or returned incomplete data', 0, id, task.address, task.network);
      }
      await tick();
    }
  }
  async function run(id) {
    if (closed || active.has(id)) return;
    active.add(id);
    try {
      let job = get.get(id);
      if (!job) return;
      if (job.status === 'importing') {
        if (job.kind === 'addresses') await importAddressCsv(job);
        else if (job.kind === 'address-keys') await importAddressKeyFile(job);
        else await importFile(job);
      }
      job = get.get(id);
      if (job?.status === 'scanning') {
        // Start one lane on each network before adding more lanes, so a slow
        // provider cannot delay every other network for a small file.
        const controller = new AbortController();
        // If a database or worker lane fails, cancel queued scans and wait for
        // every in-flight lane before releasing the job or closing its database.
        const guard = promise => promise.catch(error => { controller.abort(); throw error; });
        const networks = isAddressJob(job.kind) ? PUBLIC_NETWORKS : NETWORKS;
        const lanes = Array.from({ length: perNetwork * networks.length }, (_, index) => guard(checkWorker(id, networks[index % networks.length], controller.signal)));
        if (job.kind === 'generated' && job.generation_active) lanes.push(guard(generateContinuously(id, controller.signal)));
        const outcomes = await Promise.allSettled(lanes);
        const failure = outcomes.find(result => result.status === 'rejected');
        if (failure) {
          if (!closed) db.prepare("UPDATE checks SET status = 'pending' WHERE job = ? AND status = 'running'").run(id);
          throw failure.reason;
        }
        if (!closed) {
          pruneUnmatchedPhrases(id);
          updateStatus.run('finished', null, id);
        }
      }
    } catch (error) {
      if (closed) return;
      // Do not log exceptions from secret-bearing input or echo file content.
      // A full or unavailable disk may also prevent recording the failure;
      // leave persisted work intact for recovery on restart in that case.
      try {
        const failedJob = get.get(id);
        if (failedJob?.kind === 'generated') {
          db.prepare("UPDATE jobs SET status = 'failed', generation_active = 0, error = 'Automatic generation or scanning failed; saved results are retained.' WHERE id = ?").run(id);
        } else if (isAddressJob(failedJob?.kind) && failedJob.status === 'importing') {
          const keyFile = failedJob.kind === 'address-keys';
          const badInput = keyFile || error instanceof AddressCsvError || error instanceof AddressKeyFileError || (typeof error?.code === 'string' && error.code.startsWith('CSV_'));
          const message = keyFile
            ? error?.code === 'NO_ADDRESSES' ? 'No valid matching address/private-key pairs were found.'
              : error?.code === 'TOO_LARGE' ? 'Address/private-key file exceeds the 256 MiB upload limit.'
              : error?.code === 'ROW_TOO_LARGE' ? 'An address/private-key row exceeds the supported length.'
              : error?.code === 'UTF8' ? 'Address/private-key file must use valid UTF-8 text.'
              : 'Could not process the address/private-key file. Check that each row has an address and its matching private key.'
            : error?.code === 'COLUMNS' ? 'CSV needs a recognized public-address column such as bitcoin, ethereum, or address.'
              : error?.code === 'TOO_MANY_COLUMNS' ? 'CSV has more than 128 columns in a record.'
              : error?.code === 'RECORD_TOO_LARGE' ? 'A CSV record exceeds the 64 KiB limit.'
              : error?.code === 'NO_ADDRESSES' ? 'CSV contained no valid supported public addresses.'
              : error?.code === 'UTF8' ? 'CSV must use valid UTF-8 text.'
              : badInput ? 'Could not process the public-address CSV. Check the CSV format and try again.'
              : 'Could not process the CSV due to a server error; the encrypted upload and saved records are retained.';
          updateStatus.run('failed', message, id);
          if (badInput) {
            db.prepare('UPDATE jobs SET key = NULL, iv = NULL, tag = NULL WHERE id = ?').run(id);
            if (keyFile) {
              db.prepare('DELETE FROM checks WHERE job = ?').run(id);
              db.prepare('DELETE FROM wallets WHERE job = ?').run(id);
            }
            try { await fsp.unlink(encryptedPath(id)); } catch (_) {}
          }
        } else if (failedJob?.status === 'importing') {
          updateStatus.run('failed', 'Could not process the UTF-8 file. No complete scan was recorded.', id);
          db.prepare('UPDATE jobs SET key = NULL, iv = NULL, tag = NULL, phrase_key = NULL WHERE id = ?').run(id);
          db.prepare('DELETE FROM retained_phrases WHERE job = ?').run(id);
          try { await fsp.unlink(encryptedPath(id)); } catch (_) {}
        } else if (failedJob) {
          updateStatus.run('failed', 'Scanning stopped due to a server error; saved results and phrases are retained.', id);
        }
      } catch (_) { /* The database could not record the failure. */ }
    } finally { active.delete(id); if (closed && !active.size) closeDatabase(); }
  }
  for (const job of db.prepare("SELECT id FROM jobs WHERE status IN ('importing','scanning')").all()) setImmediate(() => run(job.id));

  return {
    receive, generate,
    stopGeneration(id, token) {
      const job = auth(id, token);
      if (!job || job.kind !== 'generated' || job.status !== 'scanning' || !job.generation_active) return false;
      return db.prepare("UPDATE jobs SET generation_active = 0, generation_reason = 'Stopped by user; queued checks will finish.' WHERE id = ? AND generation_active = 1").run(id).changes === 1;
    },
    resumeGeneration(id, token) {
      const job = auth(id, token);
      if (!job || job.kind !== 'generated' || job.status !== 'finished' || job.generation_active || hasActiveGenerator.get()) return false;
      const retainedCount = db.prepare('SELECT COUNT(*) AS count FROM retained_phrases WHERE job = ?').get(id).count;
      if (!job.phrase_key && retainedCount > 0) return false;
      const key = job.phrase_key ? null : crypto.randomBytes(32);
      try {
        db.exec('BEGIN IMMEDIATE');
        const updated = db.prepare(`UPDATE jobs SET status = 'scanning', generation_active = 1,
          generation_reason = NULL, phrase_key = COALESCE(phrase_key, ?)
          WHERE id = ? AND kind = 'generated' AND status = 'finished' AND generation_active = 0`).run(key?.toString('hex') || null, id).changes;
        if (updated !== 1) { db.exec('ROLLBACK'); return false; }
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
      finally { key?.fill(0); }
      run(id);
      return true;
    },
    // Used only by the private EC2 recovery control socket. These operations
    // run in this worker; the CLI never opens the job database for writing.
    recoveryList() {
      return db.prepare("SELECT id, status, created_at AS createdAt FROM jobs WHERE status IN ('importing','scanning','finished','failed') ORDER BY created_at DESC LIMIT 50").all();
    },
    recoveryExists(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return false;
      return Boolean(db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status IN ('importing','scanning','finished','failed')").get(id));
    },
    uploadStatus(requestId) {
      if (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId)) return null;
      const existing = db.prepare('SELECT id,kind,status FROM jobs WHERE upload_request_hash = ?').get(digest(requestId));
      if (!existing) return { found: false };
      if (existing.status === 'receiving') return { found: true, pending: true, status: 'receiving' };
      return { found: true, pending: false, id: existing.id, token: requestId, kind: isAddressJob(existing.kind) ? 'addresses' : 'upload', status: existing.status };
    },

    rotateRecoveryToken(id, token) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
      return db.prepare("UPDATE jobs SET token_hash = ? WHERE id = ? AND status IN ('importing','scanning','finished','failed')").run(digest(token), id).changes === 1;
    },
    authorized(id, token) { return Boolean(auth(id, token)); },
    status(id, token) { const job = auth(id, token); return job ? snapshot(job) : null; },
    results(id, token, offset = 0) {
      const job = auth(id, token); if (!job) return null;
      const parsed = Number(offset);
      const start = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
      const rows = db.prepare('SELECT address, network, status, assets, reason FROM checks WHERE job = ? ORDER BY address, network LIMIT 100 OFFSET ?').all(id, start);
      return { ...snapshot(job), offset: start, checks: rows.map(row => ({ ...row, assets: savedAssets(row.assets) })) };
    },
    dashboard(id, token, { assetOffset = 0, walletOffset = 0, network = 'all', prices = {} } = {}) {
      const job = auth(id, token); if (!job) return null;
      const offset = value => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
      const assetStart = offset(assetOffset); const walletStart = offset(walletOffset);
      const filter = ['all', ...NETWORKS, 'bitcoin'].includes(network) ? network : 'all';
      // Only positive checks need JSON expansion. A partial index keeps empty
      // large imports cheap while preserving all positive assets in the pages.
      const from = `FROM checks c INDEXED BY checks_positive_idx JOIN json_each(CASE WHEN json_valid(c.assets) THEN CASE WHEN json_type(c.assets) = 'array' THEN c.assets ELSE '[]' END ELSE '[]' END) a
        WHERE c.job = ? AND c.has_positive = 1
          AND length(ltrim(json_extract(c.assets, '$[' || a.key || '].rawBalance'), '0')) > 0`;
      const quoteArgs = ['bnb', 'busd', 'usdt', 'btc', 'eth'].map(key => positive(prices?.[key]));
      const summary = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(walleto_asset_value(a.value, c.network, ?, ?, ?, ?, ?)), 0) AS known_value,
        COALESCE(SUM(CASE WHEN walleto_asset_value(a.value, c.network, ?, ?, ?, ?, ?) IS NULL THEN 1 ELSE 0 END), 0) AS unpriced ${from}`).get(...quoteArgs, ...quoteArgs, id);
      const filtered = filter === 'all' ? summary.total : db.prepare(`SELECT COUNT(*) AS total ${from} AND c.network = ?`).get(id, filter).total;
      const rows = db.prepare(`SELECT c.address, c.network, c.status, a.value AS asset,
        EXISTS (SELECT 1 FROM retained_phrases p WHERE p.job = c.job AND p.address = c.address) AS phrase_available ${from}
        AND (? = 'all' OR c.network = ?)
        ORDER BY c.address, c.network, CAST(a.key AS INTEGER) LIMIT 100 OFFSET ?`).all(id, filter, filter, assetStart);
      // A small independently paginated recent list makes new finds visible
      // even if the main asset table is on a different page. All saved assets
      // remain in the normal paginated table after they leave this list.
      const recentChecks = db.prepare(`SELECT c.address, c.network, c.status, c.assets,
        EXISTS (SELECT 1 FROM retained_phrases p WHERE p.job = c.job AND p.address = c.address) AS phrase_available
        FROM checks c INDEXED BY checks_recent_positive_idx WHERE c.job = ? AND c.has_positive = 1 AND (? = 'all' OR c.network = ?)
        ORDER BY c.positive_at DESC, c.address, c.network LIMIT 12`).all(id, filter, filter);
      const recentAssets = [];
      for (const check of recentChecks) {
        for (const asset of savedAssets(check.assets)) {
          if (BigInt(asset.rawBalance) === 0n) continue;
          recentAssets.push({ address: check.address, network: check.network, status: check.status,
            phraseAvailable: Boolean(job.phrase_key && check.phrase_available), asset: { ...asset, price: usdPrice(asset, check.network, prices) } });
          if (recentAssets.length >= 12) break;
        }
        if (recentAssets.length >= 12) break;
      }
      const walletRows = db.prepare(`SELECT w.address, COUNT(c.network) AS total,
        SUM(CASE WHEN c.status IN ('done','partial','failed') THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN c.status IN ('partial','failed') THEN 1 ELSE 0 END) AS incomplete,
        MAX(COALESCE(c.has_positive, 0)) AS has_assets
        FROM (SELECT address FROM wallets WHERE job = ? AND hidden = 0 ORDER BY address LIMIT 100 OFFSET ?) w
        LEFT JOIN checks c ON c.job = ? AND c.address = w.address
        GROUP BY w.address ORDER BY w.address`).all(id, walletStart, id);
      return {
        ...snapshot(job), assetCount: summary.total, knownValue: Number.isFinite(summary.known_value) ? summary.known_value : null,
        unpriced: summary.unpriced, filteredAssetCount: filtered, assetOffset: assetStart, walletOffset: walletStart, network: filter, recentAssets,
        assets: rows.map(row => {
          const asset = JSON.parse(row.asset);
          return { address: row.address, network: row.network, status: row.status, phraseAvailable: Boolean(job.phrase_key && row.phrase_available), asset: { ...asset, price: usdPrice(asset, row.network, prices) } };
        }),
        walletPage: walletRows.map(row => ({ address: row.address, total: row.total, completed: row.completed || 0, incomplete: row.incomplete || 0, hasAssets: Boolean(row.has_assets) })),
      };
    },
    matches(id, token, offset = 0) {
      const job = auth(id, token); if (!job) return null;
      const parsed = Number(offset);
      const start = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
      if (!job.phrase_key) return { enabled: Boolean(job.retain_phrases), retained: false, total: 0, offset: start, matches: [] };
      const where = 'p.job = ? AND EXISTS (SELECT 1 FROM checks c WHERE c.job = p.job AND c.address = p.address AND c.has_positive = 1)';
      const total = db.prepare(`SELECT COUNT(*) AS count FROM retained_phrases p WHERE ${where}`).get(id).count;
      const rows = db.prepare(`SELECT p.address FROM retained_phrases p WHERE ${where} ORDER BY p.address LIMIT 20 OFFSET ?`).all(id, start);
      const checks = db.prepare('SELECT network, status, assets, reason FROM checks WHERE job = ? AND address = ? AND has_positive = 1 ORDER BY network');
      return { enabled: Boolean(job.retain_phrases), retained: true, total, offset: start, matches: rows.map(row => ({
        address: row.address,
        checks: checks.all(id, row.address).map(check => ({ ...check, assets: savedAssets(check.assets).filter(asset => BigInt(asset.rawBalance) > 0n) })),
      })) };
    },
    phrase(id, token, address) {
      const job = auth(id, token); if (!job || !job.phrase_key || typeof address !== 'string') return null;
      const row = db.prepare(`SELECT p.address, p.iv, p.tag, p.ciphertext FROM retained_phrases p
        WHERE p.job = ? AND p.address = ?
        AND EXISTS (SELECT 1 FROM checks c WHERE c.job = p.job AND c.address = p.address AND c.has_positive = 1)`).get(id, address);
      if (!row) return null;
      const value = decryptPhrase(job, row);
      return Mnemonic.isValidMnemonic(value) && Wallet.fromPhrase(value).address.toLowerCase() === row.address.toLowerCase() ? value : null;
    },
    restoreHidden(id, token) {
      if (!auth(id, token)) return null;
      return db.prepare('UPDATE wallets SET hidden = 0 WHERE job = ? AND hidden = 1').run(id).changes;
    },
    retry(id, token) {
      const job = auth(id, token); if (!job || job.status !== 'finished' || active.has(id)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE wallets SET hidden = 0 WHERE job = ? AND EXISTS (
          SELECT 1 FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address AND c.status IN ('failed','partial')
        )`).run(id);
        const retried = db.prepare("UPDATE checks SET status = 'pending', reason = NULL WHERE job = ? AND status IN ('failed','partial')").run(id).changes;
        if (job.kind === 'generated') db.prepare('UPDATE jobs SET generated_completed = generated_completed - ?, generated_incomplete = 0 WHERE id = ?').run(retried, id);
        updateStatus.run('scanning', null, id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      run(id); return true;
    },
    refreshBnb(id, token) {
      const job = auth(id, token); if (!job || job.status !== 'finished' || active.has(id)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = job.kind === 'generated' ? db.prepare(`SELECT COUNT(*) AS completed,
          COALESCE(SUM(CASE WHEN status IN ('failed','partial') THEN 1 ELSE 0 END), 0) AS incomplete
          FROM checks WHERE job = ? AND network = 'bnb' AND status IN ('done','failed','partial')`).get(id) : null;
        const result = db.prepare("UPDATE checks SET status = 'pending', reason = NULL WHERE job = ? AND network = 'bnb'").run(id);
        if (!result.changes) { db.exec('ROLLBACK'); return false; }
        if (previous) db.prepare('UPDATE jobs SET generated_completed = generated_completed - ?, generated_incomplete = generated_incomplete - ? WHERE id = ?').run(previous.completed, previous.incomplete, id);
        db.prepare(`UPDATE wallets SET hidden = 0 WHERE job = ? AND hidden = 1 AND EXISTS (
          SELECT 1 FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address AND c.network = 'bnb'
        )`).run(id);
        updateStatus.run('scanning', null, id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      run(id); return true;
    },
    remove(id, token) {
      const job = auth(id, token); if (!job || active.has(id) || !['finished', 'failed'].includes(job.status)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM checks WHERE job = ?').run(id);
        db.prepare('DELETE FROM retained_phrases WHERE job = ?').run(id);
        db.prepare('DELETE FROM wallets WHERE job = ?').run(id);
        db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      try { fs.unlinkSync(encryptedPath(id)); } catch (_) {}
      return true;
    },
    close() { if (closed) return; closed = true; scanQueue.close(); for (const worker of generationWorkers) worker.terminate(); if (!active.size) closeDatabase(); },
  };
}
module.exports = { createBackgroundJobs };
