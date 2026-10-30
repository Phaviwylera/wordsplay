import { Wallet, Mnemonic, sha256, getBytes } from 'ethers';
import { createAddressTools } from '../lib/addresses';
import { scanNativeNetwork } from '../lib/native-scanner';

window.watchAddressTools = createAddressTools(bytes => getBytes(sha256(bytes)));
window.scanNativeNetwork = scanNativeNetwork;

// Only derived public addresses and a limited set of invalid line numbers are
// returned. Never persist or send a phrase or the original file contents.
function makeParser(onProgress) {
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
        addresses.push(Wallet.fromPhrase(phrase).address);
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

window.deriveWatchAddresses = async function deriveWatchAddresses(text, onProgress = () => {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parser = makeParser(onProgress);
  // Slice pasted text as well, so a very long line does not need another huge copy.
  const chunkSize = 64 * 1024;
  for (let start = 0; start < text.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, text.length);
    await parser.feed(text.slice(start, end), start, text.length, end === text.length);
    onProgress(end, text.length);
  }
  return parser.result();
};

function readChunk(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onabort = () => reject(new Error('File read interrupted'));
    reader.readAsArrayBuffer(blob);
  });
}
window.deriveWatchFile = async function deriveWatchFile(file, onProgress = () => {}) {
  const parser = makeParser(onProgress);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunkSize = 64 * 1024;
  for (let start = 0; start < file.size; start += chunkSize) {
    const end = Math.min(start + chunkSize, file.size);
    const chunk = await readChunk(file.slice(start, end));
    const text = decoder.decode(chunk, { stream: end < file.size });
    await parser.feed(text, start, file.size, end === file.size);
    onProgress(end, file.size);
  }
  return parser.result();
};
