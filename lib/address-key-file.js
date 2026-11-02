'use strict';

const { Transform } = require('node:stream');

const MAX_ADDRESS_KEY_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ADDRESS_KEY_ROW_LENGTH = 4096;

class AddressKeyFileError extends Error {
  constructor(code) { super('Invalid Ethereum address/private-key text file'); this.code = code; }
}

function limitAddressKeyFileBytes(maxBytes = MAX_ADDRESS_KEY_FILE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid address/key upload limit');
  let size = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new AddressKeyFileError('TOO_LARGE'));
    done(null, chunk);
  } });
}

function splitRow(line) {
  const delimiter = ['\t', ',', ';', '|'].find(value => line.includes(value));
  const fields = delimiter ? line.split(delimiter) : line.trim().split(/\s+/);
  return fields.map(field => {
    const value = field.trim();
    return value.length >= 2 && value[0] === '"' && value.at(-1) === '"'
      ? value.slice(1, -1).replaceAll('""', '"').trim() : value;
  });
}

function isHeader(fields) {
  return fields.length === 2 && /address/i.test(fields[0]) && /private[ _-]*key/i.test(fields[1]);
}

// Stream records from the decrypted input. Do not retain rows or include their
// contents in errors; callers should use only a verified public address.
async function* addressKeyRows(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let first = true;
  let sawData = false;
  let lineNumber = 0;

  async function* records(text) {
    if (first) { first = false; if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); }
    buffer += text;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      lineNumber++;
      if (line.length > MAX_ADDRESS_KEY_ROW_LENGTH) throw new AddressKeyFileError('ROW_TOO_LARGE');
      const trimmed = line.trim();
      if (!trimmed) continue;
      const fields = splitRow(trimmed);
      if (!sawData && isHeader(fields)) { sawData = true; yield { header: true, lineNumber }; continue; }
      sawData = true;
      yield fields.length === 2 ? { address: fields[0], privateKey: fields[1], lineNumber } : { invalid: true, lineNumber };
    }
    if (buffer.length > MAX_ADDRESS_KEY_ROW_LENGTH) throw new AddressKeyFileError('ROW_TOO_LARGE');
  }

  try {
    for await (const chunk of input) {
      let text;
      try { text = decoder.decode(chunk, { stream: true }); }
      catch (_) { throw new AddressKeyFileError('UTF8'); }
      yield* records(text);
    }
    let tail;
    try { tail = decoder.decode(); }
    catch (_) { throw new AddressKeyFileError('UTF8'); }
    if (tail) yield* records(tail);
    if (buffer.length) {
      lineNumber++;
      if (buffer.length > MAX_ADDRESS_KEY_ROW_LENGTH) throw new AddressKeyFileError('ROW_TOO_LARGE');
      const trimmed = buffer.trim();
      if (trimmed) {
        const fields = splitRow(trimmed);
        if (!sawData && isHeader(fields)) yield { header: true, lineNumber };
        else yield fields.length === 2 ? { address: fields[0], privateKey: fields[1], lineNumber } : { invalid: true, lineNumber };
      }
    }
  } catch (error) {
    if (error instanceof AddressKeyFileError) throw error;
    throw new AddressKeyFileError('READ');
  } finally {
    buffer = '';
  }
}

module.exports = { addressKeyRows, limitAddressKeyFileBytes, AddressKeyFileError, MAX_ADDRESS_KEY_FILE_BYTES };
