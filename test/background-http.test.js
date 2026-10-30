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
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), WALLETO_BACKGROUND_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
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
