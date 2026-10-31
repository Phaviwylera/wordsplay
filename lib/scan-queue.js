'use strict';

// One slow or rate-limited provider must not occupy the whole queue. Slots are
// shared across jobs and limited per network; waiting work is FIFO among the
// networks that currently have capacity. The queue never holds wallet secrets.
function createScanQueue({ concurrency = 12, perNetwork = 3 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(perNetwork) || perNetwork < 1) throw new Error('Invalid queue limits');
  let active = 0; let closed = false;
  const counts = new Map(); const waiters = [];
  const aborted = () => Object.assign(new Error('Scan cancelled'), { name: 'AbortError' });
  const available = key => active < concurrency && (counts.get(key) || 0) < perNetwork;
  function reserve(key) {
    active++; counts.set(key, (counts.get(key) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; active--;
      const left = counts.get(key) - 1;
      if (left) counts.set(key, left); else counts.delete(key);
      pump();
    };
  }
  function pump() {
    while (!closed && active < concurrency) {
      const index = waiters.findIndex(item => available(item.key));
      if (index < 0) return;
      const item = waiters.splice(index, 1)[0];
      item.signal?.removeEventListener('abort', item.abort);
      item.resolve(reserve(item.key));
    }
  }
  function wait(key, signal) {
    return new Promise((resolve, reject) => {
      if (closed || signal?.aborted) return reject(aborted());
      const item = { key, signal, resolve, reject, abort: null };
      item.abort = () => {
        const index = waiters.indexOf(item);
        if (index >= 0) { waiters.splice(index, 1); reject(aborted()); pump(); }
      };
      waiters.push(item); signal?.addEventListener('abort', item.abort, { once: true });
      pump();
    });
  }
  async function run(key, work, signal) {
    if (closed || signal?.aborted) throw aborted();
    // Start the first available checks immediately; later work cannot jump
    // ahead of already queued eligible checks.
    const release = !waiters.length && available(key) ? reserve(key) : await wait(key, signal);
    try {
      if (closed || signal?.aborted) throw aborted();
      return await work();
    } finally { release(); }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const item of waiters.splice(0)) { item.signal?.removeEventListener('abort', item.abort); item.reject(aborted()); }
  }
  return { run, close };
}
module.exports = { createScanQueue };
