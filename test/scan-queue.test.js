'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanQueue } = require('../lib/scan-queue');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('queue caps global and per-network work and lets another network bypass a blocked one', async () => {
  const queue = createScanQueue({ concurrency: 3, perNetwork: 2 });
  const running = new Map(); const releases = new Map(); const started = [];
  let active = 0; let peak = 0;
  function work(network, name) {
    return queue.run(network, async () => {
      started.push(name); active++; peak = Math.max(peak, active);
      running.set(network, (running.get(network) || 0) + 1);
      assert.ok(running.get(network) <= 2);
      await new Promise(resolve => releases.set(name, resolve));
      running.set(network, running.get(network) - 1); active--;
      return name;
    });
  }
  const a1 = work('a', 'a1'); const a2 = work('a', 'a2');
  const a3 = work('a', 'a3'); const b1 = work('b', 'b1'); const c1 = work('c', 'c1');
  await turn();
  assert.deepEqual(started, ['a1', 'a2', 'b1']);
  releases.get('b1')(); await b1; await turn();
  assert.deepEqual(started, ['a1', 'a2', 'b1', 'c1'], 'the free slot serves an eligible network');
  releases.get('a1')(); await a1; await turn();
  assert.ok(started.includes('a3'));
  for (const name of ['a2', 'a3', 'c1']) releases.get(name)();
  await Promise.all([a2, a3, c1]);
  assert.equal(peak, 3); queue.close();
});

test('aborting or closing rejects queued checks without starting them', async () => {
  const queue = createScanQueue({ concurrency: 1, perNetwork: 1 });
  let release; const started = [];
  const first = queue.run('a', () => { started.push('first'); return new Promise(resolve => { release = resolve; }); });
  const controller = new AbortController();
  const aborted = queue.run('a', () => started.push('aborted'), controller.signal);
  const closed = queue.run('b', () => started.push('closed'));
  controller.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  queue.close(); await assert.rejects(closed, { name: 'AbortError' });
  await assert.rejects(queue.run('c', () => {}), { name: 'AbortError' });
  release(); await first; await turn();
  assert.deepEqual(started, ['first']);
});

test('invalid limits cannot accidentally create an unbounded queue', () => {
  assert.throws(() => createScanQueue({ concurrency: 0 }), /limits/i);
  assert.throws(() => createScanQueue({ perNetwork: 0 }), /limits/i);
  assert.throws(() => createScanQueue({ concurrency: Infinity }), /limits/i);
});
