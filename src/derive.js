import { Wallet, Mnemonic } from 'ethers';

// Process a line at a time to avoid an enormous array of lines for large files.
// Only public addresses and a limited list of invalid line numbers are returned.
window.deriveWatchAddresses = async function deriveWatchAddresses(text, onProgress = () => {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const addresses = [];
  const invalid = [];
  let invalidCount = 0;
  let offset = 0;
  let lineNumber = 0;
  let lastYield = Date.now();
  while (offset < text.length) {
    const next = text.indexOf('\n', offset);
    const end = next === -1 ? text.length : next;
    const line = text.slice(offset, end).trim();
    offset = next === -1 ? text.length : next + 1;
    lineNumber++;
    if (line) {
      // English phrases plus optional labels cannot be this long.
      const phrase = line.length > 500 ? '' : line.replace(/^[^:]{1,80}:\s*/, '').replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
      // Even a 24-word English BIP-39 phrase is shorter than this. Avoid
      // splitting an arbitrarily long invalid line into millions of words.
      if (phrase.length > 256 || !Mnemonic.isValidMnemonic(phrase)) {
        invalidCount++;
        if (invalid.length < 20) invalid.push(lineNumber);
      } else {
        addresses.push(Wallet.fromPhrase(phrase).address);
      }
    }
    if (Date.now() - lastYield >= 50 && offset < text.length) {
      onProgress(offset, text.length);
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = Date.now();
    }
  }
  return { addresses, invalid, invalidCount };
};
