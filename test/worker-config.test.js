const test = require('node:test');
const assert = require('node:assert/strict');
const { readWorkerLimits } = require('../lib/worker-config');

test('EC2 worker limits keep existing conservative defaults unless explicitly configured', () => {
  assert.deepEqual(readWorkerLimits({}), { concurrency: 12, perNetworkConcurrency: 3 });
  assert.deepEqual(readWorkerLimits({ WALLETO_SCAN_CONCURRENCY: '20', WALLETO_SCAN_PER_NETWORK: '4' }), { concurrency: 20, perNetworkConcurrency: 4 });
  assert.deepEqual(readWorkerLimits({ WALLETO_SCAN_CONCURRENCY: '1', WALLETO_SCAN_PER_NETWORK: '8' }), { concurrency: 1, perNetworkConcurrency: 8 });
  assert.deepEqual(readWorkerLimits({ WALLETO_SCAN_CONCURRENCY: '40' }), { concurrency: 40, perNetworkConcurrency: 3 });
});

test('invalid or excessive worker limits fail closed rather than becoming unbounded', () => {
  for (const value of ['', '0', '41', '-1', '3.5', '1e2', '04', ' 4', 'x', '99999999999999999999999999999999999999']) {
    assert.throws(() => readWorkerLimits({ WALLETO_SCAN_CONCURRENCY: value }), /WALLETO_SCAN_CONCURRENCY must be an integer between 1 and 40/);
  }
  for (const value of ['', '0', '9', '-1', '4.5', ' 4', 'x']) {
    assert.throws(() => readWorkerLimits({ WALLETO_SCAN_PER_NETWORK: value }), /WALLETO_SCAN_PER_NETWORK must be an integer between 1 and 8/);
  }
});
