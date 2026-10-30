// Address decoding shared by the server and browser. Hashing is injected so
// the server can use Node's crypto without adding a runtime dependency.
function createAddressTools(hash256) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bech = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function base58check(address) {
    if (address.length < 26 || address.length > 35) return null;
    let value = 0n;
    for (const c of address) {
      const digit = alphabet.indexOf(c);
      if (digit < 0) return null;
      value = value * 58n + BigInt(digit);
    }
    const result = [];
    while (value > 0n) { result.push(Number(value & 255n)); value >>= 8n; }
    result.reverse();
    for (const c of address) { if (c !== '1') break; result.unshift(0); }
    if (result.length !== 25) return null;
    const bytes = Uint8Array.from(result);
    const checksum = hash256(hash256(bytes.slice(0, 21)));
    if (!bytes.slice(21).every((byte, i) => byte === checksum[i])) return null;
    return bytes[0];
  }
  function polymod(values) {
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let check = 1;
    for (const value of values) {
      const top = check >>> 25;
      check = ((check & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= generators[i];
    }
    return check >>> 0;
  }
  function validSegwit(address) {
    if (address.length < 14 || address.length > 90 || (address !== address.toLowerCase() && address !== address.toUpperCase())) return false;
    const text = address.toLowerCase();
    if (!text.startsWith('bc1')) return false;
    const values = [];
    for (const char of text.slice(3)) { const value = bech.indexOf(char); if (value < 0) return false; values.push(value); }
    if (values.length < 7) return false;
    const version = values[0];
    if (version > 16 || polymod([3, 3, 0, 2, 3, ...values]) !== (version === 0 ? 1 : 0x2bc830a3)) return false;
    let bits = 0; let accumulator = 0; let size = 0;
    for (const v of values.slice(1, -6)) {
      accumulator = (accumulator << 5) | v; bits += 5;
      if (bits >= 8) { bits -= 8; size++; }
      accumulator &= (1 << bits) - 1;
    }
    if (bits >= 5 || (accumulator << (8 - bits)) !== 0) return false;
    return size >= 2 && size <= 40 && (version !== 0 || size === 20 || size === 32);
  }
  function classifyAddress(address) {
    if (typeof address !== 'string') return null;
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return { family: 'evm', key: address.toLowerCase() };
    if (validSegwit(address)) return { family: 'bitcoin', key: address.toLowerCase() };
    const version = base58check(address);
    if (version === 0 || version === 5) return { family: 'bitcoin', key: address };
    if (version === 65 && address.startsWith('T')) return { family: 'tron', key: address };
    return null;
  }
  return { classifyAddress };
}
module.exports = { createAddressTools };
