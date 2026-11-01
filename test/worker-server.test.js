const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');

test('the EC2 server passes configured limits to its single background worker', { timeout: 10000 }, async () => {
  const source = `require('./lib/background-jobs').createBackgroundJobs=(directory,options)=>{process.send({directory,options});return {}};require('./server');`;
  const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: '/private/jobs', WALLETO_SCAN_CONCURRENCY: '20', WALLETO_SCAN_PER_NETWORK: '4' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker startup timed out')), 5000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
    });
    assert.equal(result.directory, '/private/jobs');
    assert.deepEqual(result.options, { concurrency: 20, perNetworkConcurrency: 4 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  }
});

test('invalid EC2 worker limits prevent the server from starting', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
    env: { ...process.env, PORT: '0', WALLETO_BACKGROUND_DIR: '/private/jobs', WALLETO_SCAN_CONCURRENCY: '41', WALLETO_SCAN_PER_NETWORK: '4' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WALLETO_SCAN_CONCURRENCY must be an integer between 1 and 40/);
  assert.doesNotMatch(result.stdout, /Wallet viewer running/);
});
