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
const { BUSD_BSC, usdPrice, positive } = require('./prices');
const { inspectResult, mergeAssets } = require('./scan-result');
const { createScanQueue } = require('./scan-queue');

const NETWORKS = ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb'];
const tick = () => new Promise(resolve => setImmediate(resolve));
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
  if (!db.prepare('PRAGMA table_info(checks)').all().some(column => column.name === 'has_positive')) db.exec('ALTER TABLE checks ADD COLUMN has_positive INTEGER NOT NULL DEFAULT 0');
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
  // A wallet is hidden only after every expected network check is complete and
  // every checked asset has a verified zero balance. Records are never deleted.
  const expectedNetworks = NETWORKS.map(network => `'${network}'`).join(',');
  const verifiedZero = `(SELECT COUNT(*) FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address) = ${NETWORKS.length}
    AND (SELECT COUNT(*) FROM checks c WHERE c.job = wallets.job AND c.address = wallets.address
      AND c.network IN (${expectedNetworks}) AND c.status = 'done' AND c.has_positive = 0) = ${NETWORKS.length}`;
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
  // The worker repeatedly claims the first pending check. Without this partial
  // index, a large job rescans all earlier completed rows for every claim.
  db.exec("CREATE INDEX IF NOT EXISTS checks_pending_idx ON checks (job,address,network) WHERE status = 'pending'");
  db.exec('CREATE INDEX IF NOT EXISTS wallets_visibility_idx ON wallets (job,hidden,address)');
  db.exec("CREATE INDEX IF NOT EXISTS checks_pending_network_idx ON checks (job,network,address) WHERE status = 'pending'");
  db.exec('CREATE INDEX IF NOT EXISTS checks_positive_idx ON checks (job,address,network) WHERE has_positive = 1');
  // Price only valid fungible assets. The same formatting rules are used by the
  // watch-only dashboard; values are approximate, not accounting figures.
  db.function('walleto_asset_value', { deterministic: true }, (json, network, bnb, busd, btc, trx, eth) => {
    try {
      const asset = JSON.parse(json);
      const price = usdPrice(asset, network, { bnb, busd, btc, trx, eth });
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
  const setCheck = db.prepare('UPDATE checks SET status = ?, assets = ?, reason = ?, has_positive = ? WHERE job = ? AND address = ? AND network = ?');
  const addPhrase = db.prepare('INSERT OR IGNORE INTO retained_phrases (job,address,iv,tag,ciphertext) VALUES (?,?,?,?,?)');
  const pending = db.prepare("SELECT address,network FROM checks WHERE job = ? AND network = ? AND status = 'pending' ORDER BY address LIMIT 1");
  const updateVisibility = db.prepare(`UPDATE wallets SET hidden = CASE WHEN ${verifiedZero} THEN 1 ELSE 0 END WHERE job = ? AND address = ?`);
  function commitCheck(status, assets, reason, hasPositive, id, address, network) {
    db.exec('BEGIN IMMEDIATE');
    try {
      setCheck.run(status, assets, reason, hasPositive, id, address, network);
      updateVisibility.run(id, address);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const summary = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('done','partial','failed') THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status IN ('partial','failed') THEN 1 ELSE 0 END) AS incomplete FROM checks WHERE job = ?");
  const scan = options.scan || scanWallet;
  const active = new Set();
  let closed = false;
  const perNetwork = options.perNetworkConcurrency ?? 3;
  // All jobs share this queue. Twelve concurrent checks, with at most three per
  // network, let healthy networks progress even if another provider is slow.
  const scanQueue = createScanQueue({ concurrency: options.concurrency ?? 12, perNetwork });
  const boundedScan = (address, network) => scanQueue.run(network, () => scan(address, network));

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
    const counts = summary.get(job.id);
    const walletCounts = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(hidden), 0) AS hidden FROM wallets WHERE job = ?').get(job.id);
    return { id: job.id, status: job.status, createdAt: job.created_at, lines: job.lines, invalid: job.invalid, wallets: walletCounts.count, visibleWallets: walletCounts.count - walletCounts.hidden, hiddenWallets: walletCounts.hidden, total: counts.total, completed: counts.completed || 0, incomplete: counts.incomplete || 0, error: job.error, phraseMatching: Boolean(job.retain_phrases), retainsPhrases: Boolean(job.phrase_key) };
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

  async function receive(stream, { retainPhrases = false } = {}) {
    const id = random(); const token = random();
    const key = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
    const phraseKey = retainPhrases ? crypto.randomBytes(32) : null;
    const filename = encryptedPath(id);
    db.prepare("INSERT INTO jobs (id,token_hash,status,created_at,retain_phrases) VALUES (?,?,'receiving',?,?)").run(id, digest(token), new Date().toISOString(), retainPhrases ? 1 : 0);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      await pipeline(stream, cipher, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      const tag = cipher.getAuthTag();
      db.prepare("UPDATE jobs SET status = 'importing', key = ?, iv = ?, tag = ?, phrase_key = ? WHERE id = ?").run(key.toString('hex'), iv.toString('hex'), tag.toString('hex'), phraseKey?.toString('hex') || null, id);
      run(id);
      return { id, token };
    } catch (error) {
      try { await fsp.unlink(filename); } catch (_) {}
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      throw error;
    } finally { key.fill(0); phraseKey?.fill(0); }
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

  async function checkWorker(id, network) {
    while (!closed) {
      const task = pending.get(id, network);
      if (!task) return;
      const previous = find.get(id, task.address, task.network);
      db.prepare("UPDATE checks SET status = 'running' WHERE job = ? AND address = ? AND network = ?").run(id, task.address, task.network);
      try {
        const result = await boundedScan(task.address, task.network);
        if (closed) return;
        const coverage = inspectResult(result, task.network, task.address);
        const earlier = savedAssets(previous?.assets);
        // Persist an explicit freshness flag so legacy partial results, which
        // lack one, can be conservatively labelled as previous in the UI.
        const assets = mergeAssets(earlier, result.assets, coverage).map(asset => ({ ...asset, stale: Boolean(asset.stale) }));
        const hasPositive = assets.some(asset => BigInt(asset.rawBalance) > 0n);
        const reason = coverage.partial ? (!coverage.native ? 'Native balance unavailable; token results may be available.' : task.network === 'bnb' ? 'BUSD check unavailable; retry.' : 'Token and NFT data unavailable; retry.') : null;
        commitCheck(coverage.partial ? 'partial' : 'done', JSON.stringify(assets), reason, hasPositive ? 1 : 0, id, task.address, task.network);
      } catch (_) {
        if (closed) return;
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
      if (job.status === 'importing') await importFile(job);
      job = get.get(id);
      if (job?.status === 'scanning') {
        // Start one lane on each network before adding more lanes, so a slow
        // provider cannot delay every other network for a small file.
        await Promise.all(Array.from({ length: perNetwork * NETWORKS.length }, (_, index) => checkWorker(id, NETWORKS[index % NETWORKS.length])));
        if (!closed) {
          pruneUnmatchedPhrases(id);
          updateStatus.run('finished', null, id);
        }
      }
    } catch (_) {
      if (closed) return;
      // Do not log exceptions from secret-bearing input or echo file content.
      updateStatus.run('failed', 'Could not process the UTF-8 file. No complete scan was recorded.', id);
      db.prepare('UPDATE jobs SET key = NULL, iv = NULL, tag = NULL, phrase_key = NULL WHERE id = ?').run(id);
      db.prepare('DELETE FROM retained_phrases WHERE job = ?').run(id);
      try { await fsp.unlink(encryptedPath(id)); } catch (_) {}
    } finally { active.delete(id); }
  }
  for (const job of db.prepare("SELECT id FROM jobs WHERE status IN ('importing','scanning')").all()) setImmediate(() => run(job.id));

  return {
    receive,
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
      const filter = ['all', ...NETWORKS, 'bitcoin', 'tron'].includes(network) ? network : 'all';
      // Only positive checks need JSON expansion. A partial index keeps empty
      // large imports cheap while preserving all positive assets in the pages.
      const from = `FROM checks c JOIN json_each(CASE WHEN json_valid(c.assets) THEN CASE WHEN json_type(c.assets) = 'array' THEN c.assets ELSE '[]' END ELSE '[]' END) a
        WHERE c.job = ? AND c.has_positive = 1
          AND length(ltrim(json_extract(c.assets, '$[' || a.key || '].rawBalance'), '0')) > 0`;
      const quoteArgs = ['bnb', 'busd', 'btc', 'trx', 'eth'].map(key => positive(prices?.[key]));
      const summary = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(walleto_asset_value(a.value, c.network, ?, ?, ?, ?, ?)), 0) AS known_value,
        COALESCE(SUM(CASE WHEN walleto_asset_value(a.value, c.network, ?, ?, ?, ?, ?) IS NULL THEN 1 ELSE 0 END), 0) AS unpriced ${from}`).get(...quoteArgs, ...quoteArgs, id);
      const filtered = filter === 'all' ? summary.total : db.prepare(`SELECT COUNT(*) AS total ${from} AND c.network = ?`).get(id, filter).total;
      const rows = db.prepare(`SELECT c.address, c.network, c.status, a.value AS asset,
        EXISTS (SELECT 1 FROM retained_phrases p WHERE p.job = c.job AND p.address = c.address) AS phrase_available ${from}
        AND (? = 'all' OR c.network = ?)
        ORDER BY c.address, c.network, CAST(a.key AS INTEGER) LIMIT 100 OFFSET ?`).all(id, filter, filter, assetStart);
      const walletRows = db.prepare(`SELECT w.address, COUNT(c.network) AS total,
        SUM(CASE WHEN c.status IN ('done','partial','failed') THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN c.status IN ('partial','failed') THEN 1 ELSE 0 END) AS incomplete,
        MAX(COALESCE(c.has_positive, 0)) AS has_assets
        FROM (SELECT address FROM wallets WHERE job = ? AND hidden = 0 ORDER BY address LIMIT 100 OFFSET ?) w
        LEFT JOIN checks c ON c.job = ? AND c.address = w.address
        GROUP BY w.address ORDER BY w.address`).all(id, walletStart, id);
      return {
        ...snapshot(job), assetCount: summary.total, knownValue: Number.isFinite(summary.known_value) ? summary.known_value : null,
        unpriced: summary.unpriced, filteredAssetCount: filtered, assetOffset: assetStart, walletOffset: walletStart, network: filter,
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
        db.prepare("UPDATE checks SET status = 'pending', reason = NULL WHERE job = ? AND status IN ('failed','partial')").run(id);
        updateStatus.run('scanning', null, id); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      run(id); return true;
    },
    refreshBnb(id, token) {
      const job = auth(id, token); if (!job || job.status !== 'finished' || active.has(id)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare("UPDATE checks SET status = 'pending', reason = NULL WHERE job = ? AND network = 'bnb'").run(id);
        if (!result.changes) { db.exec('ROLLBACK'); return false; }
        db.prepare('UPDATE wallets SET hidden = 0 WHERE job = ? AND hidden = 1').run(id);
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
    close() { closed = true; scanQueue.close(); if (!active.size) db.close(); },
  };
}
module.exports = { createBackgroundJobs };
