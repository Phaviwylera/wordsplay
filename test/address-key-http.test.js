'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Wallet } = require('ethers');

function request(port, method, resource, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: resource, headers }, res => {
      let result = ''; res.setEncoding('utf8'); res.on('data', data => { result += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(result) }));
    });
    req.on('error', reject); req.end(body);
  });
}
function childPort(child) {
  return new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Wallet viewer running on port (\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`server exited: ${code}`)); });
  });
}
async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  }
}

test('address/private-key files upload only through the private address-search endpoint and become address-only jobs', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walleto-http-address-keys-'));
  const source = `require('./lib/market').getMarket=async()=>({currency:'INR',usdToInr:83,prices:{}});
    require('./lib/scanner').scanWallet=async (address,network)=>({address,network,assets:[{type:'native',symbol:'ETH',rawBalance:'0',decimals:18,price:null},...(network==='bnb'?[{type:'BEP-20',symbol:'BUSD',contract:'0xe9e7cea3dedca5984780bafc599bd69add087d56',rawBalance:'0',decimals:18,price:null}]:[])],...(network==='bnb'?{coverage:'bnb-and-busd'}:{})});
    require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await childPort(child); const host = `127.0.0.1:${port}`;
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/octet-stream' };
    const endpoint = '/api/background/jobs/address-keys';
    const privateKey = `0x${'0'.repeat(63)}1`;
    const address = new Wallet(privateKey).address;
    const rows = `${address}\t${privateKey}\n`;
    assert.equal((await request(port, 'POST', endpoint, { ...headers, host: 'evil.example' }, rows)).status, 403);
    assert.equal((await request(port, 'POST', endpoint, { ...headers, origin: 'http://evil.example' }, rows)).status, 403);
    assert.equal((await request(port, 'POST', endpoint, { ...headers, 'content-type': 'text/plain' }, rows)).status, 403);
    assert.equal((await request(port, 'POST', endpoint, { ...headers, 'content-length': String(256 * 1024 * 1024 + 1) })).status, 413);

    const uploaded = await request(port, 'POST', endpoint, headers, rows);
    assert.equal(uploaded.status, 202); assert.deepEqual(Object.keys(uploaded.body).sort(), ['id', 'kind', 'token']);
    assert.equal(uploaded.body.kind, 'addresses');
    const { id, token } = uploaded.body;
    let status;
    for (let i = 0; i < 200; i++) {
      status = (await request(port, 'GET', `/api/background/jobs/${id}`, { host, authorization: `Bearer ${token}` })).body;
      if (['finished', 'failed'].includes(status.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.status, 'finished'); assert.equal(status.kind, 'addresses');
    assert.equal(status.addressFormat, 'key-pairs'); assert.equal(status.wallets, 1); assert.equal(status.total, 5);
    assert.equal(status.invalid, 0); assert.equal(status.retainsPhrases, false); assert.equal(status.phraseMatching, false);
    assert.equal(JSON.stringify(status).includes(privateKey), false);
    assert.equal(fs.existsSync(path.join(dir, `${id}.upload`)), false);
    const database = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
    try {
      const stored = database.prepare('SELECT key,iv,tag,phrase_key FROM jobs WHERE id=?').get(id);
      assert.equal(stored.key, null); assert.equal(stored.iv, null); assert.equal(stored.tag, null); assert.equal(stored.phrase_key, null);
    } finally { database.close(); }
  } finally { await stopChild(child); fs.rmSync(dir, { recursive: true, force: true }); }
});
