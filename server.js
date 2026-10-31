const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/scan');
const publicDir = path.join(__dirname, 'public');
// Enable only on a loopback-published EC2 container accessed by SSH tunnel.
// The persistent directory must be private to the service account.
const jobs = process.env.WALLETO_BACKGROUND_DIR ? require('./lib/background-jobs').createBackgroundJobs(process.env.WALLETO_BACKGROUND_DIR) : null;
function privateBackgroundRequest(req) {
  const host = req.headers.host || '';
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return true;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/background/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    try {
    if (!jobs || !privateBackgroundRequest(req)) return send(403, { error: 'File import requires a private SSH tunnel and EC2 worker configuration.' });
    const match = url.pathname.match(/^\/api\/background\/jobs\/([a-f0-9]{64})(?:\/(results|dashboard|matches|phrase|retry))?$/);
    if (req.method === 'POST' && url.pathname === '/api/background/jobs') {
      if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type'] !== 'application/octet-stream') return send(403, { error: 'Invalid upload origin.' });
      try { const result = await jobs.receive(req, { retainPhrases: true }); return send(202, result); }
      catch (_) { if (!res.destroyed) return send(500, { error: 'Upload did not complete. Try again while connected.' }); return; }
    }
    if (!match) return send(404, { error: 'Not found.' });
    const [, id, action] = match;
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!jobs.authorized(id, token)) return send(404, { error: 'Job not found.' });
    if (req.method === 'GET' && !action) return send(200, jobs.status(id, token));
    if (req.method === 'GET' && action === 'results') return send(200, jobs.results(id, token, url.searchParams.get('offset')));
    if (req.method === 'GET' && action === 'dashboard') return send(200, jobs.dashboard(id, token, {
      assetOffset: url.searchParams.get('assetOffset'), walletOffset: url.searchParams.get('walletOffset'), network: url.searchParams.get('network') || 'all',
    }));
    if (req.method === 'GET' && action === 'matches') return send(200, jobs.matches(id, token, url.searchParams.get('offset')));
    if (req.method === 'GET' && action === 'phrase') {
      const phrase = jobs.phrase(id, token, url.searchParams.get('address'));
      return phrase ? send(200, { phrase }) : send(404, { error: 'No retained phrase for a positive-balance wallet.' });
    }
    if (req.method === 'POST' && action === 'retry' && req.headers.origin === `http://${req.headers.host}`) {
      return jobs.retry(id, token) ? send(202, { ok: true }) : send(409, { error: 'Job cannot be retried yet.' });
    }
    if (req.method === 'DELETE' && !action && req.headers.origin === `http://${req.headers.host}`) {
      return jobs.remove(id, token) ? send(200, { ok: true }) : send(409, { error: 'Only finished jobs can be removed.' });
    }
    return send(405, { error: 'Method not allowed.' });
    } catch (_) {
      if (!res.destroyed && !res.writableEnded) return send(500, { error: 'Background service unavailable.' });
      return;
    }
  }
  if (url.pathname === '/api/scan') {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    return handler(req, res);
  }
  const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/background.js': ['background.js', 'text/javascript'], '/derive-bundle.js': ['derive-bundle.js', 'text/javascript'], '/direct-scan.js': ['direct-scan.js', 'text/javascript'], '/wordlist': ['wordlist.html', 'text/html'], '/wordlist.js': ['wordlist.js', 'text/javascript'], '/bip39-english.txt': ['bip39-english.txt', 'text/plain'], '/bip39-wordlist-LICENSE.txt': ['bip39-wordlist-LICENSE.txt', 'text/plain'], '/wallet': ['wallet.html', 'text/html'], '/wallet-bundle.js': ['wallet-bundle.js', 'text/javascript'] };
  const file = files[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': `${file[1]}; charset=utf-8` };
  if (url.pathname === '/') {
    headers['Cache-Control'] = 'no-store';
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://eth.blockscout.com https://base.blockscout.com https://arbitrum.blockscout.com https://optimism.blockscout.com https://ethereum-rpc.publicnode.com https://arbitrum-one-rpc.publicnode.com https://optimism-rpc.publicnode.com https://mempool.space https://api.trongrid.io https://bsc-rpc.publicnode.com; object-src 'none'; base-uri 'none'; form-action 'self'";
    headers['Referrer-Policy'] = 'no-referrer';
  }
  if (url.pathname === '/wordlist') {
    headers['Cache-Control'] = 'no-store';
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
    headers['Referrer-Policy'] = 'no-referrer';
  }
  if (url.pathname === '/wallet') {
    headers['Cache-Control'] = 'no-store';
    headers['Content-Security-Policy'] = "default-src 'self'; connect-src 'self' https://ethereum-rpc.publicnode.com https://base-rpc.publicnode.com https://arbitrum-one-rpc.publicnode.com https://optimism-rpc.publicnode.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    headers['X-Frame-Options'] = 'DENY';
    headers['Referrer-Policy'] = 'no-referrer';
  }
  res.writeHead(200, headers);
  fs.createReadStream(path.join(publicDir, file[0])).pipe(res);
}).listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`Wallet viewer running on port ${process.env.PORT || 3000}`));
// Large private uploads can take longer than Node's default request timeout.
if (jobs) server.requestTimeout = 0;
