'use strict';

const { Interface } = require('ethers');

// Canonical Multicall3 CREATE2 address on Ethereum, Base, Arbitrum, Optimism,
// and BNB Smart Chain. A failed call is handled by the caller's legacy path.
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
const RPC_ENDPOINTS = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
};
const multicallInterface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function balanceOf(address account) view returns (uint256)',
]);
const UINT256 = /^0x[\da-f]{64}$/i;

async function rpcRequest(fetcher, endpoint, id, method, params) {
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) throw Object.assign(new Error(`RPC returned ${response.status}`), { status: response.status });
  const data = await response.json();
  if (data?.jsonrpc !== '2.0' || data.id !== id || data.error) throw new Error(`Invalid ${method} response`);
  return data.result;
}

// Read every requested value through one aggregate3 eth_call at a captured
// block number. Multicall's per-call allowFailure lets callers fall back only
// for components the contract/provider did not return.
async function readMulticall3(network, calls, fetcher = fetch) {
  const endpoint = RPC_ENDPOINTS[network];
  if (!endpoint || !Array.isArray(calls) || !calls.length) throw new Error('Unsupported Multicall3 request');
  const blockResult = await rpcRequest(fetcher, endpoint, 73101, 'eth_blockNumber', []);
  if (typeof blockResult !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]*)$/i.test(blockResult)) throw new Error('Invalid block number from RPC');
  const blockNumber = `0x${BigInt(blockResult).toString(16)}`;
  const encodedCalls = calls.map(call => [call.target, true, multicallInterface.encodeFunctionData(call.method, call.args)]);
  const payload = multicallInterface.encodeFunctionData('aggregate3', [encodedCalls]);
  const result = await rpcRequest(fetcher, endpoint, 73102, 'eth_call', [{ to: MULTICALL3_ADDRESS, data: payload }, blockNumber]);
  if (typeof result !== 'string' || !/^0x[\da-f]+$/i.test(result)) throw new Error('Invalid Multicall3 response');
  const decoded = multicallInterface.decodeFunctionResult('aggregate3', result)[0];
  if (!Array.isArray(decoded) || decoded.length !== calls.length) throw new Error('Invalid Multicall3 result count');
  const values = decoded.map((item, index) => {
    if (!item.success || typeof item.returnData !== 'string' || !UINT256.test(item.returnData)) return { success: false };
    try {
      const [value] = multicallInterface.decodeFunctionResult(calls[index].method, item.returnData);
      return { success: true, value: BigInt(value).toString() };
    } catch (_) { return { success: false }; }
  });
  return { blockNumber, values };
}

module.exports = { MULTICALL3_ADDRESS, RPC_ENDPOINTS, multicallInterface, readMulticall3 };
