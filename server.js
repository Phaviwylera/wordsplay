const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('./api/scan');
const publicDir = path.join(__dirname, 'public');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/scan') {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    return handler(req, res);
  }
  const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/derive-bundle.js': ['derive-bundle.js', 'text/javascript'], '/direct-scan.js': ['direct-scan.js', 'text/javascript'], '/wordlist': ['wordlist.html', 'text/html'], '/wordlist.js': ['wordlist.js', 'text/javascript'], '/bip39-english.txt': ['bip39-english.txt', 'text/plain'], '/bip39-wordlist-LICENSE.txt': ['bip39-wordlist-LICENSE.txt', 'text/plain'], '/wallet': ['wallet.html', 'text/html'], '/wallet-bundle.js': ['wallet-bundle.js', 'text/javascript'] };
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
