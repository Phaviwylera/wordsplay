const networks = {
  ethereum: { name: 'Ethereum', short: 'ETH', color: '#627eea' }, base: { name: 'Base', short: 'B', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', short: 'A', color: '#28a0f0' }, optimism: { name: 'Optimism', short: 'OP', color: '#ff0420' },
  bnb: { name: 'BNB Smart Chain', short: 'BNB', color: '#d39b16' }, bitcoin: { name: 'Bitcoin', short: 'BTC', color: '#f7931a' }, tron: { name: 'TRON', short: 'TRX', color: '#eb0029' },
};
const { classifyAddress } = window.watchAddressTools;
const familyNetworks = { evm: ['ethereum', 'base', 'arbitrum', 'optimism', 'bnb'], bitcoin: ['bitcoin'], tron: ['tron'] };
const keyFor = address => classifyAddress(address)?.key;
const networksFor = address => familyNetworks[classifyAddress(address)?.family] || [];
const nativeOnlyNetworks = new Set(['bitcoin', 'tron', 'bnb']);
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const shortAddress = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;
let wallets = [];
try {
  const saved = JSON.parse(localStorage.getItem('walleto.wallets') || '[]');
  if (Array.isArray(saved)) {
    const seen = new Set();
    wallets = saved.filter(w => {
      if (!w || !classifyAddress(w.address)) return false;
      const address = keyFor(w.address);
      if (seen.has(address)) return false;
      seen.add(address); return true;
    }).map(w => ({ address: w.address }));
  }
} catch (_) { /* Storage may be unavailable. */ }
let scanData = { total: 0, completed: 0, failed: 0, assets: [], knownValue: 0, unpriced: 0 };
let walletPage = 0;
let assetPage = 0;
const PAGE_SIZE = 100;
const SCAN_CONCURRENCY = 8;
let walletStates = new Map();
let zeroWallets = new Set();
let failedChecks = new Map();
let scanVersion = 0;
let loading = false;
let scanController = null;
let renderTimer = null;
function persist() { try { localStorage.setItem('walleto.wallets', JSON.stringify(wallets)); return true; } catch (_) { return false; } }
function importStatus(text, error = false) { const el = $('#import-status'); el.textContent = text; el.hidden = false; el.classList.toggle('error', error); }
function addAddresses(addresses) {
  let added = 0; let duplicates = 0;
  const seen = new Set(wallets.map(wallet => keyFor(wallet.address)));
  for (const address of addresses) {
    const normalized = keyFor(address);
    if (!normalized) continue;
    if (seen.has(normalized)) { duplicates++; continue; }
    seen.add(normalized);
    // Bech32 is case-insensitive; Base58 addresses (Bitcoin/TRON) are not.
    const storedAddress = /^bc1/i.test(address) ? normalized : address;
    wallets.push({ address: storedAddress }); added++;
  }
  const saved = !added || persist();
  if (added) scan();
  return { added, duplicates, saved };
}
function amount(raw, decimals) {
  try {
    const digits = BigInt(raw).toString();
    const places = Math.max(0, Math.min(100, Number(decimals) || 0));
    const padded = digits.padStart(places + 1, '0');
    return Number(places ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded);
  } catch (_) { return 0; }
}
function money(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value); }
function quantity(value) { return value > 0 && value < 0.00000001 ? '<0.00000001' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(value); }
function updatePager(prefix, page, count) {
  const pager = $(`#${prefix}-pager`);
  pager.hidden = count <= PAGE_SIZE;
  $(`#${prefix}-page-label`).textContent = `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, count)} of ${count}`;
  $(`#${prefix}-prev`).disabled = page === 0;
  $(`#${prefix}-next`).disabled = (page + 1) * PAGE_SIZE >= count;
}
function walletScanLabel(wallet) {
  const state = walletStates.get(keyFor(wallet.address));
  if (!state) return { css: '', label: 'Waiting to scan' };
  const total = networksFor(wallet.address).length;
  if (state.done < total) return { css: '', label: `Scanning ${state.done}/${total} networks` };
  if (state.failed) return { css: 'incomplete', label: `⚠ Incomplete · ${state.failed} failed` };
  return { css: 'complete', label: state.limited ? '✓ Scanned · native-only coverage on some networks' : state.hasAssets ? '✓ Scanned · assets found' : '✓ Scanned · no assets found' };
}
function render() {
  const selected = $('#network-filter').value;
  const { total, completed, failed, assets: items, knownValue, unpriced } = scanData;
  const pending = total - completed;
  const succeeded = completed - failed;
  const visible = selected === 'all' ? items : items.filter(a => a.network === selected);
  const noReliableTotal = wallets.length && ((!succeeded) || (knownValue === 0 && (failed || pending || unpriced)));
  $('#total-value').textContent = noReliableTotal ? '—' : money(knownValue);
  $('#value-note').textContent = !wallets.length ? 'Add a wallet to get started' : pending ? 'Scanning your wallets…' : failed ? (succeeded ? 'Partial results · some networks unavailable' : 'Balance unavailable · scan failed') : unpriced ? `${unpriced} asset${unpriced === 1 ? '' : 's'} without a price` : 'Across all your wallets';
  $('#wallet-count').textContent = $('#wallet-badge').textContent = wallets.length;
  $('#asset-count').textContent = items.length;
  $('#asset-badge').textContent = visible.length;
  $('#wallet-empty').hidden = wallets.length > 0;
  walletPage = Math.min(walletPage, Math.max(0, Math.ceil(wallets.length / PAGE_SIZE) - 1));
  assetPage = Math.min(assetPage, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  $('#wallet-list').innerHTML = wallets.slice(walletPage * PAGE_SIZE, (walletPage + 1) * PAGE_SIZE).map(wallet => { const state = walletScanLabel(wallet); return `<div class="wallet-row"><span class="wallet-avatar">◈</span><div class="wallet-info"><strong title="${escapeHtml(wallet.address)}">${escapeHtml(wallet.address)}</strong><span class="wallet-scan-state ${state.css}">${escapeHtml(state.label)}</span></div><button class="remove-wallet" data-address="${escapeHtml(wallet.address)}" aria-label="Remove ${escapeHtml(wallet.address)}" title="Remove wallet">×</button></div>`; }).join('');
  $('#asset-list').innerHTML = visible.slice(assetPage * PAGE_SIZE, (assetPage + 1) * PAGE_SIZE).map(asset => `<tr><td><div class="asset-name"><span class="token-icon" style="--token-color:${asset.meta.color}">${escapeHtml(asset.symbol.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)} · ${escapeHtml(shortAddress(asset.wallet.address))}${asset.tokenId ? ` · #${escapeHtml(asset.tokenId)}` : ''}</small></span></div></td><td><span class="network-pill"><i style="background:${asset.meta.color}"></i>${asset.meta.name}</span></td><td><strong>${quantity(asset.balance)}</strong><small>${escapeHtml(asset.symbol)}</small></td><td><strong>${asset.price === null ? '—' : money(asset.balance * asset.price)}</strong><small>${asset.price === null ? (asset.nft ? 'Collectible' : 'Price unavailable') : 'USD'}</small></td></tr>`).join('');
  updatePager('wallet', walletPage, wallets.length);
  updatePager('asset', assetPage, visible.length);
  $('#empty-state').hidden = visible.length > 0;
  const empty = $('#empty-state');
  if (wallets.length) {
    empty.querySelector('h3').textContent = pending ? 'Looking for your assets…' : failed ? 'Some networks couldn’t be scanned.' : 'No assets found here.';
    empty.querySelector('p').textContent = pending ? 'This may take a few moments.' : failed ? 'Try refreshing, or choose another network.' : 'Try another network or add another wallet.';
    empty.querySelector('button').hidden = true;
  } else {
    empty.querySelector('h3').textContent = 'No assets to show';
    empty.querySelector('p').textContent = 'Add a wallet address to see its indexed assets here.';
    empty.querySelector('button').hidden = false;
  }
  const status = $('#scan-status');
  status.hidden = !wallets.length || (!failed && !pending);
  status.textContent = pending ? `Scanning ${pending} wallet network${pending === 1 ? '' : 's'}…` : `${failed} wallet network${failed === 1 ? '' : 's'} could not be scanned. Results are incomplete; retry the failed checks.`;
  const percentage = total ? Math.floor(completed * 100 / total) : 0;
  $('#scan-progress').hidden = !wallets.length;
  $('#progress-bar').value = percentage;
  $('#progress-percent').textContent = `${percentage}%`;
  $('#progress-text').textContent = pending ? 'Scanning balances…' : failed ? 'Scan finished with errors' : 'Scan complete';
  $('#progress-detail').textContent = `${completed} of ${total} network checks finished${failed ? ` · ${failed} failed` : ''}.`;
  const errorDetails = $('#scan-errors');
  errorDetails.hidden = loading || !failedChecks.size;
  if (!errorDetails.hidden) {
    const counts = {};
    const reasons = new Set();
    for (const check of failedChecks.values()) { counts[check.network] = (counts[check.network] || 0) + 1; reasons.add(check.reason); }
    const byNetwork = Object.entries(counts).map(([network, count]) => `${networks[network].name}: ${count}`).join(' · ');
    const explanations = { limited: 'Rate limiting detected', invalid: 'Invalid or incomplete indexer data', unavailable: 'Indexer or network unavailable' };
    errorDetails.textContent = `${byNetwork}. ${[...reasons].map(reason => explanations[reason]).join('; ')}. Failed checks are not treated as zero.`;
  }
  $('#retry-failed').hidden = loading || !failedChecks.size;
  const eligible = zeroWallets.size;
  $('#remove-zero').hidden = !wallets.length;
  $('#remove-zero').disabled = loading || eligible === 0;
  $('#zero-help').hidden = !wallets.length;
  $('#zero-help').textContent = 'Unavailable while some supported networks have native-only coverage; token and inscription balances may be missed. Failed scans are never treated as zero.';
  $('#remove-zero').textContent = `Remove zero-balance wallets (${eligible})`;
  $('#remove-all').disabled = !wallets.length;
  $('#remove-all').textContent = `Remove all wallets (${wallets.length})`;
  $('#refresh').classList.toggle('spinning', loading);
  $('#refresh').disabled = loading || !wallets.length;
}
function recordWalletScan(wallet, hasAssets, failed, network) {
  const address = keyFor(wallet.address);
  const state = walletStates.get(address) || { done: 0, failed: 0, hasAssets: false, limited: false };
  state.done++; state.failed += failed ? 1 : 0; state.hasAssets ||= hasAssets; state.limited ||= nativeOnlyNetworks.has(network);
  walletStates.set(address, state);
  if (state.done === networksFor(wallet.address).length && !state.failed && !state.hasAssets && !state.limited) zeroWallets.add(address);
}
// Keep requests bounded for large imports. Cancel the previous scan when the
// tracked address list changes, and never send recovery phrases to an indexer.
async function scanRequest(url, options, signal, timeout) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted || options.signal?.aborted) controller.abort();
  else {
    signal.addEventListener('abort', cancel, { once: true });
    options.signal?.addEventListener('abort', cancel, { once: true });
  }
  const timer = setTimeout(cancel, timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); options.signal?.removeEventListener('abort', cancel); }
}
function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, wallets.length > 1000 ? 1000 : 150);
}
function failureReason(error) {
  if (error?.status === 429 || error?.serverStatus === 429) return 'limited';
  if (/invalid|unexpected/i.test(error?.message || '')) return 'invalid';
  return 'unavailable';
}
function transientFailure(error) {
  return [429, 500, 502, 503, 504].includes(error?.status) || [429, 500, 502, 503, 504].includes(error?.serverStatus) || ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name);
}
function retryDelay(signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 700 + Math.random() * 300);
    signal.addEventListener('abort', done, { once: true });
  });
}
async function scan(retryFailed = false) {
  const retry = retryFailed === true;
  if (retry && (loading || !failedChecks.size)) return;
  if (scanController) scanController.abort();
  scanController = new AbortController();
  const signal = scanController.signal;
  const directFetcher = (url, options) => scanRequest(url, options, signal, 15000);
  const version = ++scanVersion;
  const scanWallets = wallets.slice();
  let retryTasks = null;
  if (retry) {
    retryTasks = [...failedChecks.values()];
    scanData.completed -= retryTasks.length;
    scanData.failed -= retryTasks.length;
    for (const { wallet } of retryTasks) {
      const state = walletStates.get(keyFor(wallet.address));
      if (state) { state.done--; state.failed--; }
    }
    failedChecks.clear();
  } else {
    scanData = { total: scanWallets.reduce((total, wallet) => total + networksFor(wallet.address).length, 0), completed: 0, failed: 0, assets: [], knownValue: 0, unpriced: 0 };
    walletStates = new Map(); zeroWallets = new Set(); failedChecks = new Map();
  }
  const taskCount = retry ? retryTasks.length : scanData.total;
  loading = taskCount > 0; render();
  let next = 0; let walletIndex = 0; let networkIndex = 0;
  function nextFullTask() {
    const wallet = scanWallets[walletIndex];
    const keys = networksFor(wallet.address);
    const network = keys[networkIndex++];
    if (networkIndex === keys.length) { walletIndex++; networkIndex = 0; }
    return { wallet, network };
  }
  async function worker() {
    while (!signal.aborted && next < taskCount) {
      const task = next++;
      const { wallet, network } = retry ? retryTasks[task] : nextFullTask();
      const address = wallet.address;
      try {
        let data;
        for (let attempt = 0; ; attempt++) {
          try {
            try {
              const response = await scanRequest(`/api/scan?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}`, {}, signal, 17000);
              if (!response.ok) throw Object.assign(new Error('Server scan failed'), { status: response.status });
              data = await response.json();
              if (!Array.isArray(data.assets)) throw new Error('Invalid response');
            } catch (serverError) {
              if (signal.aborted) return;
              try { data = await scanDirect(address, network, directFetcher); }
              catch (error) { if (error && typeof error === 'object') error.serverStatus = serverError.status; throw error; }
            }
            if (!Array.isArray(data.assets) || !data.assets.some(asset => asset && asset.type === 'native') || data.assets.some(asset => !asset || typeof asset.rawBalance !== 'string' || !/^\d+$/.test(asset.rawBalance))) throw new Error('Invalid balances');
            break;
          } catch (error) {
            if (signal.aborted) return;
            if (attempt >= 1 || !transientFailure(error)) throw error;
            await retryDelay(signal);
            if (signal.aborted) return;
          }
        }
        if (version === scanVersion && !signal.aborted) {
          const hasAssets = data.assets.some(asset => BigInt(asset.rawBalance) > 0n);
          for (const asset of data.assets) {
            const balance = amount(asset.rawBalance, asset.decimals);
            if (balance <= 0) continue;
            const nft = /ERC-721|ERC-1155/i.test(asset.type);
            const price = asset.price !== null && asset.price !== '' && Number.isFinite(Number(asset.price)) && Number(asset.price) >= 0 && !nft ? Number(asset.price) : null;
            scanData.assets.push({ ...asset, balance, price, nft, network, meta: networks[network], wallet });
            if (price === null) scanData.unpriced++; else scanData.knownValue += balance * price;
          }
          scanData.completed++;
          recordWalletScan(wallet, hasAssets, false, network);
        }
      } catch (error) {
        if (version === scanVersion && !signal.aborted) {
          scanData.failed++; scanData.completed++;
          failedChecks.set(`${keyFor(address)}:${network}`, { wallet, network, reason: failureReason(error) });
          recordWalletScan(wallet, false, true, network);
        }
      }
      if (version === scanVersion && !signal.aborted) scheduleRender();
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, taskCount) }, worker));
  if (version === scanVersion) {
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
    loading = false; render();
  }
}
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => {
  $('#import-wallets').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#wallet-address').focus({ preventScroll: true });
}));
$('#address-form').addEventListener('submit', event => {
  event.preventDefault();
  const field = $('#wallet-address');
  const address = field.value.trim();
  if (!classifyAddress(address)) return importStatus('Enter a valid Bitcoin, TRON or EVM public address.', true);
  const result = addAddresses([address]);
  field.value = '';
  importStatus(result.duplicates ? 'This address is already being tracked.' : result.saved ? 'Address added. Scanning balances…' : 'Address added for this session, but browser storage is unavailable.', !result.saved);
});
$('#seed-file').addEventListener('change', () => {
  // Do not display the file name: it might itself contain sensitive information.
  $('#file-name').textContent = $('#seed-file').files.length ? 'Text file selected' : 'No file selected';
});
$('#seed-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#seed-form button[type="submit"]');
  if (submit.disabled) return;
  const pasted = $('#seed-phrases').value;
  const file = $('#seed-file').files[0];
  // Clear visible secrets and file selection immediately, including on errors.
  $('#seed-phrases').value = ''; $('#seed-file').value = ''; $('#file-name').textContent = 'No file selected';
  if (!pasted.trim() && !file) return importStatus('Paste a seed phrase or choose a .txt file.', true);
  if (file && !/\.txt$/i.test(file.name)) return importStatus('Choose a UTF-8 .txt file.', true);
  submit.disabled = true;
  try {
    const sources = [];
    if (pasted.trim()) sources.push({ label: 'Pasted text', text: pasted });
    if (file) sources.push({ label: 'Text file', file });
    const addresses = []; const problems = [];
    for (const source of sources) {
      importStatus(`Processing ${source.label.toLowerCase()} locally…`);
      const updateProgress = (done, total) => importStatus(`Processing ${source.label.toLowerCase()}: ${total ? Math.floor(done * 100 / total) : 100}%…`);
      const result = source.file ? await window.deriveWatchFile(source.file, updateProgress) : await window.deriveWatchAddresses(source.text, updateProgress);
      for (const address of result.addresses) addresses.push(address);
      if (result.invalid.length) {
        const shown = result.invalid.slice(0, 20).join(', ');
        const extra = result.invalidCount > 20 ? ` and ${result.invalidCount - 20} more` : '';
        problems.push(`${source.label}: invalid line${result.invalid.length === 1 ? '' : 's'} ${shown}${extra}`);
      }
    }
    const { added, duplicates, saved } = addAddresses(addresses);
    const parts = [`${added} wallet${added === 1 ? '' : 's'} added`, ...(duplicates ? [`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`] : []), ...problems];
    if (!saved) parts.push('Browser storage is full or unavailable; new wallets will only last this session');
    if (!addresses.length && !problems.length) parts.push('No phrases found');
    importStatus(`${parts.join(' · ')}. ${added ? 'Scanning balances…' : 'Use one complete valid phrase per line.'}`, !saved || problems.length > 0 || !addresses.length);
  } catch (_) { importStatus('Could not read or process the input. Try a UTF-8 .txt file with one valid phrase per line.', true); }
  finally { submit.disabled = false; }
});
$('#wallet-list').addEventListener('click', event => {
  const button = event.target.closest('[data-address]');
  if (!button) return;
  wallets = wallets.filter(wallet => keyFor(wallet.address) !== keyFor(button.dataset.address));
  const saved = persist(); scan();
  if (!saved) importStatus('The removal could not be saved in browser storage.', true);
});
$('#remove-all').addEventListener('click', () => {
  const count = wallets.length;
  if (!count || !confirm(`Remove all ${count} wallet${count === 1 ? '' : 's'} from the watch list? Any ongoing balance scan will stop. This does not delete your wallets or funds.`)) return;
  wallets = [];
  walletPage = 0; assetPage = 0;
  const saved = persist();
  scan(); // Abort in-flight requests and invalidate any late results.
  importStatus(saved ? `Removed all ${count} wallet${count === 1 ? '' : 's'} from the watch list.` : `Removed all ${count} wallet${count === 1 ? '' : 's'} for this session, but browser storage could not save the change; wallets may return after a reload.`, !saved);
});
$('#remove-zero').addEventListener('click', () => {
  if (loading || !zeroWallets.size) return;
  const count = zeroWallets.size;
  if (!confirm(`Remove ${count} wallet${count === 1 ? '' : 's'} with no assets found on their completely scanned networks? This removes only the watch list entries, not the wallets or funds. Other chains and unindexed assets are not checked.`)) return;
  const removedChecks = wallets.filter(wallet => zeroWallets.has(keyFor(wallet.address))).reduce((sum, wallet) => sum + networksFor(wallet.address).length, 0);
  wallets = wallets.filter(wallet => !zeroWallets.has(keyFor(wallet.address)));
  for (const address of zeroWallets) walletStates.delete(address);
  zeroWallets.clear();
  scanData.total -= removedChecks;
  scanData.completed -= removedChecks;
  const saved = persist(); render();
  importStatus(saved ? `Removed ${count} zero-balance wallet${count === 1 ? '' : 's'} from the watch list.` : `Removed ${count} wallet${count === 1 ? '' : 's'} for this session, but browser storage could not save the change.`, !saved);
});
$('#network-filter').addEventListener('change', () => { assetPage = 0; render(); });
$('#wallet-prev').addEventListener('click', () => { walletPage--; render(); });
$('#wallet-next').addEventListener('click', () => { walletPage++; render(); });
$('#asset-prev').addEventListener('click', () => { assetPage--; render(); });
$('#asset-next').addEventListener('click', () => { assetPage++; render(); });
$('#refresh').addEventListener('click', () => scan());
$('#retry-failed').addEventListener('click', () => scan(true));
$('#today').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
scan();
