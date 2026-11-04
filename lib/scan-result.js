'use strict';

const { BUSD_BSC, USDT_BSC, BTCB_BSC, USDT_ETH, WBTC_ETH } = require('./prices');
const NATIVE_ONLY = new Set(['bitcoin']);

// Distinguish unknown components from verified zero balances. A partial
// response may include a verified native balance, broad indexed tokens, or the
// explicitly enumerated Ethereum Multicall subset. Missing data remains stale.
function inspectResult(result, network, expectedAddress) {
  if (!result || !Array.isArray(result.assets) || result.assets.some(a => !a || typeof a.rawBalance !== 'string' || !/^\d+$/.test(a.rawBalance) || a.rawBalance.replace(/^0+/, '').length > 78 || !((typeof a.decimals === 'number' && Number.isInteger(a.decimals)) || (typeof a.decimals === 'string' && /^\d+$/.test(a.decimals))) || Number(a.decimals) < 0 || Number(a.decimals) > 255)) throw new Error('Invalid scan result');
  if (result.network !== undefined && result.network !== network) throw new Error('Invalid scan network');
  if (result.address !== undefined && expectedAddress !== undefined) {
    const insensitive = network !== 'bitcoin' || /^bc1/i.test(expectedAddress);
    const actual = typeof result.address === 'string' ? result.address : '';
    if ((insensitive ? actual.toLowerCase() : actual) !== (insensitive ? expectedAddress.toLowerCase() : expectedAddress)) throw new Error('Invalid scan address');
  }
  if (![undefined, 'complete', 'native-only', 'tokens-only', 'known-tokens-only', 'bnb-tokens-only', 'bnb-and-busd', 'bnb-and-stables', 'bnb-and-known'].includes(result.coverage)) throw new Error('Invalid scan coverage');
  const explicit = result.components;
  let native, tokens; let knownTokens = [];
  if (explicit !== undefined) {
    if (!explicit || typeof explicit.native !== 'boolean' || typeof explicit.tokens !== 'boolean') throw new Error('Invalid scan coverage');
    if (explicit.knownTokens !== undefined) {
      if (network !== 'ethereum' || !Array.isArray(explicit.knownTokens) || explicit.knownTokens.some(contract => typeof contract !== 'string' || ![USDT_ETH, WBTC_ETH].includes(contract.toLowerCase())) || new Set(explicit.knownTokens.map(contract => contract.toLowerCase())).size !== explicit.knownTokens.length) throw new Error('Invalid known-token coverage');
      knownTokens = explicit.knownTokens.map(contract => contract.toLowerCase());
    }
    ({ native, tokens } = explicit);
  } else {
    native = result.coverage !== 'tokens-only';
    tokens = result.coverage !== 'native-only';
    // An older unmarked BNB response with only the coin is not evidence that
    // BUSD was checked. Treat it as retryable rather than silently complete.
    if (network === 'bnb' && result.coverage === undefined && !result.assets.some(a => typeof a.contract === 'string' && a.contract.toLowerCase() === BUSD_BSC)) tokens = false;
  }
  if ((result.coverage === 'native-only' && (!native || tokens)) || (['tokens-only', 'bnb-tokens-only'].includes(result.coverage) && (native || !tokens)) || (result.coverage === 'known-tokens-only' && (native || tokens || !knownTokens.length)) || (['complete', 'bnb-and-busd', 'bnb-and-stables', 'bnb-and-known'].includes(result.coverage) && (!native || !tokens))) throw new Error('Invalid scan coverage');
  const nativeCount = result.assets.filter(a => a.type === 'native').length;
  if ((native && nativeCount !== 1) || (!native && nativeCount !== 0) || (!native && !tokens && !knownTokens.length)) throw new Error('Invalid scan coverage');
  if (!tokens && result.assets.some(asset => asset.type !== 'native' && !(asset.type === 'ERC-20' && asset.tokenId == null && knownTokens.includes(String(asset.contract || '').toLowerCase())))) throw new Error('Invalid token coverage');
  const seen = new Set();
  for (const asset of result.assets) {
    if (asset.type === 'native' || typeof asset.contract !== 'string' || !asset.contract) continue;
    const key = `${asset.contract.toLowerCase()}:${String(asset.tokenId ?? '')}`;
    if (seen.has(key)) throw new Error('Duplicate token balance');
    seen.add(key);
  }
  if (network === 'bnb' && tokens && (explicit !== undefined || result.coverage !== undefined)) {
    const contracts = new Set(result.assets.filter(a => typeof a.contract === 'string').map(a => a.contract.toLowerCase()));
    if (!contracts.has(BUSD_BSC)) throw new Error('Missing BUSD check');
    if (['bnb-and-stables', 'bnb-and-known', 'bnb-tokens-only'].includes(result.coverage) && !contracts.has(USDT_BSC)) throw new Error('Missing USDT check');
    if (['bnb-and-known', 'bnb-tokens-only'].includes(result.coverage) && !contracts.has(BTCB_BSC)) throw new Error('Missing BTCB check');
  }
  return { native, tokens, partial: !native || (!tokens && !NATIVE_ONLY.has(network)), ...(knownTokens.length ? { knownTokens } : {}) };
}
function mergeAssets(previous, incoming, coverage) {
  // Each component returned by the scanner is a complete, validated snapshot.
  // Keep only missing prior data as stale. A Multicall-verified known token
  // replaces its old value even when broad indexed token discovery failed.
  const current = incoming.map(asset => { const copy = { ...asset }; delete copy.stale; return copy; });
  const checkedKnown = new Set((coverage.knownTokens || []).map(contract => contract.toLowerCase()));
  const retained = (Array.isArray(previous) ? previous : []).filter(asset => asset && (asset.type === 'native'
    ? !coverage.native
    : !coverage.tokens && !(typeof asset.contract === 'string' && checkedKnown.has(asset.contract.toLowerCase())))).map(asset => ({ ...asset, stale: true }));
  return [...current, ...retained];
}
module.exports = { inspectResult, mergeAssets };
