'use strict';

// These are in-flight wallet/network checks, not separate processes. A check
// may send several provider requests. Keep conservative defaults and a ceiling
// so a typo cannot produce unbounded requests to shared public providers.
function readWorkerLimits(env = process.env) {
  function integer(name, fallback, max) {
    const value = env[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}.`);
    }
    return Number(value);
  }
  return {
    concurrency: integer('WALLETO_SCAN_CONCURRENCY', 12, 40),
    perNetworkConcurrency: integer('WALLETO_SCAN_PER_NETWORK', 3, 8),
  };
}

module.exports = { readWorkerLimits };
