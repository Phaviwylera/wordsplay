'use strict';

// Stream only recognized public-address columns. Never include an ignored
// field, filename, CSV row or parser error in a job result or log.
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parse } = require('csv-parse');

const MAX_ADDRESS_CSV_BYTES = 256 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_COLUMNS = 128;
const columns = new Map([
  ...['address', 'public_address', 'wallet_address'].map(name => [name, null]),
  ...['btc', 'bitcoin', 'btc_address', 'bitcoin_address', 'btc_native_segwit', 'bitcoin_native_segwit'].map(name => [name, 'bitcoin']),
  ...['evm', 'evm_address', 'eth', 'eth_address', 'ethereum', 'ethereum_address', 'bnb', 'bnb_address', 'bsc', 'bsc_address', 'bnb_smart_chain', 'base', 'base_address', 'arbitrum', 'arbitrum_address', 'optimism', 'optimism_address'].map(name => [name, 'evm']),
]);

class AddressCsvError extends Error {
  constructor(code) { super('Invalid public-address CSV'); this.code = code; }
}

function limitAddressCsvBytes(maxBytes = MAX_ADDRESS_CSV_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid CSV upload limit');
  let size = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new AddressCsvError('TOO_LARGE'));
    done(null, chunk);
  } });
}

// Count raw bytes and separators as well as field content. The CSV parser's
// max_record_size counts field content, so a line of empty comma-separated
// fields would otherwise allocate an enormous row before it could be rejected.
function limitCsvRecords() {
  let bytes = 0; let fields = 1; let quoted = false; let closingQuote = false;
  return new Transform({ transform(chunk, _encoding, done) {
    try {
      for (const byte of chunk) {
        if (++bytes > MAX_RECORD_BYTES) throw new AddressCsvError('RECORD_TOO_LARGE');
        if (quoted) {
          if (!closingQuote) { if (byte === 34) closingQuote = true; continue; }
          if (byte === 34) { closingQuote = false; continue; } // Escaped quote.
          quoted = false; closingQuote = false;
        }
        if (byte === 34) quoted = true;
        else if (byte === 44 && ++fields > MAX_COLUMNS) throw new AddressCsvError('TOO_MANY_COLUMNS');
        else if (byte === 10 || byte === 13) { bytes = 0; fields = 1; }
      }
      done(null, chunk);
    } catch (error) { done(error); }
  } });
}

// Yields recognized cells from one record at a time. Quoted commas, escaped
// quotes, embedded newlines, CRLF, a UTF-8 BOM and split multibyte characters
// are handled by the streaming decoder and CSV parser. Invalid UTF-8 or CSV
// never turns into a verified-zero scan.
async function* addressCsvRows(input) {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const decode = new Transform({
    transform(chunk, _encoding, done) {
      try { done(null, utf8.decode(chunk, { stream: true })); }
      catch (_) { done(new AddressCsvError('UTF8')); }
    },
    flush(done) {
      try { done(null, utf8.decode()); }
      catch (_) { done(new AddressCsvError('UTF8')); }
    },
  });
  const records = limitCsvRecords();
  const parser = parse({ bom: true, trim: true, skip_empty_lines: true, relax_column_count: true, max_record_size: MAX_RECORD_BYTES });
  let pipeError;
  // Capture the pipeline rejection immediately while the iterator consumes the
  // parser, so malformed files cannot create unhandled promise rejections.
  const pumping = pipeline(input, records, decode, parser).catch(error => { pipeError = error; });
  let selected = null;
  try {
    for await (const record of parser) {
      if (selected === null) {
        if (record.length > MAX_COLUMNS) throw new AddressCsvError('TOO_MANY_COLUMNS');
        selected = record.flatMap((header, index) => {
          const name = header.trim().toLowerCase().replace(/[\s-]+/g, '_');
          return columns.has(name) ? [{ index, family: columns.get(name) }] : [];
        });
        if (!selected.length) throw new AddressCsvError('COLUMNS');
        continue;
      }
      yield selected.map(({ index, family }) => ({ value: (record[index] || '').trim(), family }));
    }
    await pumping;
    if (pipeError) throw pipeError;
    if (selected === null) throw new AddressCsvError('COLUMNS');
  } finally {
    parser.destroy(); decode.destroy(); records.destroy(); input.destroy();
    await pumping;
  }
}

module.exports = { addressCsvRows, limitAddressCsvBytes, AddressCsvError, MAX_ADDRESS_CSV_BYTES };
