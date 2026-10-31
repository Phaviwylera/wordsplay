const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function request(port, method, resource, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: resource, headers }, res => {
      let result = ''; res.setEncoding('utf8'); res.on('data', data => { result += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(result) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('background endpoints require SSH-style loopback host, same origin and a job token', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-http-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const source = "require('./lib/market').getMarket=async()=>({currency:'INR',usdToInr:83,prices:{}});require('./server');";
  const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, PORT: String(port), WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Wallet viewer running')) { clearTimeout(timeout); resolve(); } });
    child.on('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  try {
    const host = `127.0.0.1:${port}`;
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/octet-stream' };
    assert.equal((await request(port, 'POST', '/api/background/jobs', { ...headers, host: 'example.com' })).status, 403);
    assert.equal((await request(port, 'POST', '/api/background/jobs', { ...headers, origin: 'http://evil.example' })).status, 403);
    assert.equal((await request(port, 'POST', '/api/background/jobs', { host, 'content-type': 'application/octet-stream' })).status, 403);
    const result = await request(port, 'POST', '/api/background/jobs', headers, '');
    assert.equal(result.status, 202);
    const { id, token } = result.body;
    assert.equal((await request(port, 'GET', `/api/background/jobs/${id}`, { host })).status, 404);
    assert.equal((await request(port, 'GET', `/api/background/jobs/${id}`, { host, authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await request(port, 'GET', `/api/background/jobs/${id}/dashboard`, { host })).status, 404);
    assert.equal((await request(port, 'GET', `/api/background/jobs/${id}/dashboard`, { ...headers, host: 'example.com', authorization: `Bearer ${token}` })).status, 403);
    const dashboard = await request(port, 'GET', `/api/background/jobs/${id}/dashboard?assetOffset=0&walletOffset=0&network=ethereum`, { host, authorization: `Bearer ${token}` });
    assert.equal(dashboard.status, 200); assert.deepEqual(dashboard.body.assets, []); assert.deepEqual(dashboard.body.walletPage, []);
    assert.equal(dashboard.body.network, 'ethereum'); assert.equal(dashboard.body.market.usdToInr, 83);
    const market = await request(port, 'GET', '/api/market', { host });
    assert.equal(market.status, 200); assert.equal(market.body.currency, 'INR');
    assert.equal((await request(port, 'POST', '/api/market', { host })).status, 405);
    const refresh = `/api/background/jobs/${id}/refresh-bnb`;
    assert.equal((await request(port, 'POST', refresh, { ...headers, origin: 'http://evil.example', authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await request(port, 'POST', refresh, { host, authorization: `Bearer ${token}` })).status, 405);
    assert.equal((await request(port, 'POST', refresh, { ...headers, authorization: `Bearer ${'0'.repeat(64)}` })).status, 404);
    assert.equal((await request(port, 'POST', refresh, { ...headers, authorization: `Bearer ${token}` })).status, 409); // Empty job has no BNB checks.
    const matches = await request(port, 'GET', `/api/background/jobs/${id}/matches`, { host, authorization: `Bearer ${token}` });
    assert.equal(matches.status, 200);
    assert.deepEqual(matches.body.matches, []);
    assert.equal(matches.body.enabled, true);
    assert.equal(typeof matches.body.retained, 'boolean');
    const phrase = await request(port, 'GET', `/api/background/jobs/${id}/phrase?address=0x123`, { host, authorization: `Bearer ${token}` });
    assert.equal(phrase.status, 404);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slow market providers do not block the EC2 balance page; later refresh includes the INR quote', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-http-prices-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const source = `let quote=null;let waiters=[];process.on('message',()=>{quote={currency:'INR',usdToInr:83,prices:{}};for(const resolve of waiters)resolve(quote);waiters=[];process.send('ready')});
    require('./lib/market').getMarket=()=>quote?Promise.resolve(quote):new Promise(resolve=>waiters.push(resolve));
    require('./lib/scanner').scanWallet=async (_address,network)=>({assets:[{name:'Native',symbol:'ETH',type:'native',rawBalance:'1000000000000000000',decimals:18,price:'2'},...(network==='bnb'?[{name:'BUSD',symbol:'BUSD',type:'BEP-20',contract:'0xe9e7cea3dedca5984780bafc599bd69add087d56',rawBalance:'0',decimals:18,price:null}]:[])],...(network==='bnb'?{coverage:'bnb-and-busd'}:{})});
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, PORT: String(port), WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error('server startup timeout')), 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Wallet viewer running')) { clearTimeout(timeout); resolve(); } });
      child.on('exit', code => reject(new Error(`server exited: ${code}`)));
    });
    const host = `127.0.0.1:${port}`;
    const upload = await request(port, 'POST', '/api/background/jobs', { host, origin: `http://${host}`, 'content-type': 'application/octet-stream' }, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const { id, token } = upload.body; const headers = { host, authorization: `Bearer ${token}` };
    let status;
    for (let i = 0; i < 50; i++) {
      status = (await request(port, 'GET', `/api/background/jobs/${id}`, headers)).body;
      if (status.status === 'finished') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.status, 'finished');
    const started = Date.now();
    const first = await request(port, 'GET', `/api/background/jobs/${id}/dashboard`, headers);
    assert.ok(Date.now() - started < 2000, 'slow prices must not block the balance response');
    assert.equal(first.body.assetCount, 5); assert.equal(first.body.knownValue, 10);
    assert.equal(first.body.market.usdToInr, null, 'an unavailable rate is not fabricated');
    const released = new Promise(resolve => child.once('message', resolve));
    child.send('release market quote'); await released;
    const refreshed = await request(port, 'GET', `/api/background/jobs/${id}/dashboard`, headers);
    assert.equal(refreshed.body.market.usdToInr, 83); assert.equal(refreshed.body.knownValue, 10);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
