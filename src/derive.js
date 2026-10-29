import { Wallet, Mnemonic } from 'ethers';

// The import format is deliberately unambiguous: one complete phrase per line.
// Labels ending in ':' and numbered list prefixes are accepted for common text exports.
window.deriveWatchAddresses = function deriveWatchAddresses(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const nonEmpty = lines.filter(line => line.trim());
  if (nonEmpty.length > 50) return { addresses: [], invalid: [], tooMany: true };
  const addresses = [];
  const invalid = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const phrase = line.trim().replace(/^[^:]{1,80}:\s*/, '').replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!Mnemonic.isValidMnemonic(phrase)) { invalid.push(index + 1); return; }
    // Wallet.fromPhrase uses m/44'/60'/0'/0/0 and an empty BIP-39 passphrase.
    addresses.push(Wallet.fromPhrase(phrase).address);
  });
  return { addresses, invalid, tooMany: false };
};
