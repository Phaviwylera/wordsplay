'use strict';

const { BUSD_BSC } = require('./prices');
const NATIVE_ONLY = new Set(['bitcoin', 'tron']);

// Distinguish unknown components from verified zero balances. A partial
// response can contain only tokens or only the native coin. Missing components
// may be retained from a previous snapshot; unknown is never treated as zero.
function inspectResult(result, network, expectedAddress) {
  if (!result || !Array.isArray(result.assets) || result.assets.some(a => !a || typeof a.rawBalance !== 'string' || !/^\d+$/.test(a.rawBalance) || a.rawBalance.replace(/^0+/, '').length > 78 || !((typeof a.decimals === 'number' && Number.isInteger(a.decimals)) || (typeof a.decimals === 'string' && /^\d+$/.test(a.decimals))) || Number(a.decimals) < 0 || Number(a.decimals) > 255)) throw new Error('Invalid scan result');
  if (result.network !== undefined && result.network !== network) throw new Error('Invalid scan network');
  if (result.address !== undefined && expectedAddress !== undefined) {
    const insensitive = !['bitcoin', 'tron'].includes(network) || /^bc1/i.test(expectedAddress);
    const actual = typeof result.address === 'string' ? result.address : '';
    if ((insensitive ? actual.toLowerCase() : actual) !== (insensitive ? expectedAddress.toLowerCase() : expectedAddress)) throw new Error('Invalid scan address');
  }
  if (![undefined, 'complete', 'native-only', 'tokens-only', 'bnb-and-busd'].includes(result.coverage)) throw new Error('Invalid scan coverage');
  const explicit = result.components;
  let native, tokens;
  if (explicit !== undefined) {
    if (!explicit || typeof explicit.native !== 'boolean' || typeof explicit.tokens !== 'boolean') throw new Error('Invalid scan coverage');
    ({ native, tokens } = explicit);
  } else {
    native = result.coverage !== 'tokens-only';
    tokens = result.coverage !== 'native-only';
    // An older unmarked BNB response with only the coin is not evidence that
    // BUSD was checked. Treat it as retryable rather than silently complete.
    if (network === 'bnb' && result.coverage === undefined && !result.assets.some(a => typeof a.contract === 'string' && a.contract.toLowerCase() === BUSD_BSC)) tokens = false;
  }
  if ((result.coverage === 'native-only' && (!native || tokens)) || (result.coverage === 'tokens-only' && (native || !tokens)) || (['complete', 'bnb-and-busd'].includes(result.coverage) && (!native || !tokens))) throw new Error('Invalid scan coverage');
  const nativeCount = result.assets.filter(a => a.type === 'native').length;
  if ((native && nativeCount !== 1) || (!native && nativeCount !== 0) || (!native && !tokens)) throw new Error('Invalid scan coverage');
  if (!tokens && result.assets.some(a => a.type !== 'native')) throw new Error('Invalid token coverage');
  const seen = new Set();
  for (const asset of result.assets) {
    if (asset.type === 'native' || typeof asset.contract !== 'string' || !asset.contract) continue;
    const key = `${asset.contract.toLowerCase()}:${String(asset.tokenId ?? '')}`;
    if (seen.has(key)) throw new Error('Duplicate token balance');
    seen.add(key);
  }
  if (network === 'bnb' && tokens && (explicit !== undefined || result.coverage !== undefined) && !result.assets.some(a => typeof a.contract === 'string' && a.contract.toLowerCase() === BUSD_BSC)) throw new Error('Missing BUSD check');
  return { native, tokens, partial: !native || (!tokens && !NATIVE_ONLY.has(network)) };
}
function mergeAssets(previous, incoming, coverage) {
  // Each component returned by the scanner is a complete, validated snapshot.
  // Keep only the missing components from the previous snapshot; these are
  // explicitly marked stale until a successful recheck replaces them.
  const current = incoming.map(asset => { const copy = { ...asset }; delete copy.stale; return copy; });
  const retained = (Array.isArray(previous) ? previous : []).filter(asset => asset && (asset.type === 'native' ? !coverage.native : !coverage.tokens)).map(asset => ({ ...asset, stale: true }));
  return [...current, ...retained];
}
module.exports = { inspectResult, mergeAssets };
