import { Wallet, Mnemonic, sha256, getBytes } from 'ethers';
import { createAddressTools } from '../lib/addresses';
import { scanNativeNetwork } from '../lib/native-scanner';
import { scanEvmNativeFallback } from '../lib/evm-fallback';

window.watchAddressTools = createAddressTools(bytes => getBytes(sha256(bytes)));
window.scanNativeNetwork = scanNativeNetwork;
window.scanEvmNativeFallback = scanEvmNativeFallback;

// 128 cryptographically random bits plus the BIP-39 checksum produce 12 words.
// Fail closed if the browser cannot provide secure randomness.
window.generateWatchPhrase = function generateWatchPhrase() {
  if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') {
    throw new Error('Secure randomness is unavailable');
  }
  const entropy = new Uint8Array(16);
  window.crypto.getRandomValues(entropy);
  try { return Mnemonic.fromEntropy(entropy).phrase; }
  finally { entropy.fill(0); }
};

// Explicitly unlock a matching self-custody keystore for export. Decryption,
// verification, and the returned phrase stay on the device; nothing is sent.
window.unlockCustodyRecoveryPhrase = async function unlockCustodyRecoveryPhrase(json, password) {
  const account = await Wallet.fromEncryptedJson(json, password);
  const phrase = account.mnemonic?.phrase;
  if (!phrase || !Mnemonic.isValidMnemonic(phrase) || Wallet.fromPhrase(phrase).address.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('Recovery phrase unavailable');
  }
  return { address: account.address, phrase };
};

// Only public addresses and limited invalid-line details are returned. An
// optional callback can retain validated phrases in the current tab for
// export; the parser itself never persists or sends them.
function makeParser(onProgress, onPhrase) {
  const addresses = [];
  const invalid = [];
  let invalidCount = 0;
  let lineNumber = 0;
  let carry = '';
  let tooLong = false;
  let lastYield = Date.now();
  function addPart(part) {
    if (tooLong) return;
    // Keep whitespace bounded even if a single line is enormous. A valid
    // English phrase with its optional label cannot exceed 500 characters.
    carry = (carry + part).replace(/\s+/g, ' ').trimStart();
    if (carry.trimEnd().length > 500) { carry = ''; tooLong = true; }
  }
  function finishLine() {
    lineNumber++;
    const line = carry.trim();
    if (tooLong || line) {
      const phrase = tooLong ? '' : line.replace(/^[^:]{1,80}:\s*/, '').replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (tooLong || phrase.length > 256 || !Mnemonic.isValidMnemonic(phrase)) {
        invalidCount++;
        if (invalid.length < 20) invalid.push(lineNumber);
      } else {
        const address = Wallet.fromPhrase(phrase).address;
        addresses.push(address);
        if (onPhrase) onPhrase(address, phrase);
      }
    }
    carry = '';
    tooLong = false;
  }
  return {
    async feed(text, done, total, final = false) {
      let offset = 0;
      for (;;) {
        const next = text.indexOf('\n', offset);
        if (next === -1) { addPart(text.slice(offset)); break; }
        addPart(text.slice(offset, next));
        finishLine();
        offset = next + 1;
        if (Date.now() - lastYield >= 50) {
          onProgress(done, total);
          await new Promise(resolve => setTimeout(resolve, 0));
          lastYield = Date.now();
        }
      }
      if (final && (carry || tooLong)) finishLine();
    },
    result() { return { addresses, invalid, invalidCount }; },
  };
}

window.deriveWatchAddresses = async function deriveWatchAddresses(text, onProgress = () => {}, onPhrase) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parser = makeParser(onProgress, onPhrase);
  // Slice pasted text as well, so a very long line does not need another huge copy.
  const chunkSize = 64 * 1024;
  for (let start = 0; start < text.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, text.length);
    await parser.feed(text.slice(start, end), start, text.length, end === text.length);
    onProgress(end, text.length);
  }
  return parser.result();
};
