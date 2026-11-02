'use strict';

// CPU-heavy BIP-39/HD derivation stays off the server's event loop. The
// worker returns secrets only to its parent process, never to providers or the
// browser. The parent encrypts each phrase before storing it in the job.
const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');
const { Mnemonic, Wallet } = require('ethers');

parentPort.on('message', count => {
  try {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid batch size');
    const batch = [];
    for (let i = 0; i < count; i++) {
      const entropy = crypto.randomBytes(16);
      try {
        const phrase = Mnemonic.fromEntropy(entropy).phrase;
        batch.push({ phrase, address: Wallet.fromPhrase(phrase).address });
      } finally { entropy.fill(0); }
    }
    parentPort.postMessage({ batch });
  } catch (_) {
    // Never send exceptions or generated content to a log.
    parentPort.postMessage({ error: true });
  }
});
