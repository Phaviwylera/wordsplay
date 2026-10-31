const networks = {
  ethereum: { name: 'Ethereum', short: 'ETH', color: '#627eea' }, base: { name: 'Base', short: 'B', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', short: 'A', color: '#28a0f0' }, optimism: { name: 'Optimism', short: 'OP', color: '#ff0420' },
  bnb: { name: 'BNB Smart Chain', short: 'BNB', color: '#d39b16' }, bitcoin: { name: 'Bitcoin', short: 'BTC', color: '#f7931a' }, tron: { name: 'TRON', short: 'TRX', color: '#eb0029' },
};
const { classifyAddress } = window.watchAddressTools;
const fileScan = window.fileScan || null;
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
    }).map(w => w.source === 'seed' ? { address: w.address, source: 'seed' } : { address: w.address });
  }
} catch (_) { /* Storage may be unavailable. */ }
let scanData = { total: 0, completed: 0, failed: 0, assets: [], knownValue: 0, unpriced: 0 };
// Recovery phrases are deliberately separate from the persisted watch list.
const sessionPhrases = new Map();
let pendingPhraseImport = null;
let phraseSessionVersion = 0;
let renderedAssets = [];
let activeExport = null;
let exportVisibilityVersion = 0;
let exportOpener = null;
const pendingExportUrls = new Set();
let walletPage = 0;
let assetPage = 0;
let fileAssetPage = 0;
let fileWalletPage = 0;
let viewMode = fileScan?.snapshot().hasJob ? 'file' : 'watch';
let watchInitialized = false;
const PAGE_SIZE = 100;
const SCAN_CONCURRENCY = 8;
let walletStates = new Map();
let zeroWallets = new Set();
let failedChecks = new Map();
let scanVersion = 0;
let loading = false;
let scanController = null;
let renderTimer = null;
let storageDirty = false;
function persist() {
  try { localStorage.setItem('walleto.wallets', JSON.stringify(wallets)); storageDirty = false; return true; }
  catch (_) { storageDirty = true; return false; }
}
function importStatus(text, error = false) { const el = $('#import-status'); el.textContent = text; el.hidden = false; el.classList.toggle('error', error); }
function addAddresses(addresses, source = 'address') {
  let added = 0; let duplicates = 0; let changed = false;
  const byAddress = new Map(wallets.map(wallet => [keyFor(wallet.address), wallet]));
  for (const address of addresses) {
    const normalized = keyFor(address);
    if (!normalized) continue;
    const existing = byAddress.get(normalized);
    if (existing) {
      duplicates++;
      // A seed re-import can relink an existing public address for this tab.
      if (source === 'seed' && existing.source !== 'seed') { existing.source = 'seed'; changed = true; }
      continue;
    }
    // Bech32 is case-insensitive; Base58 addresses (Bitcoin/TRON) are not.
    const storedAddress = /^bc1/i.test(address) ? normalized : address;
    const wallet = source === 'seed' ? { address: storedAddress, source: 'seed' } : { address: storedAddress };
    byAddress.set(normalized, wallet);
    wallets.push(wallet); added++; changed = true;
  }
  const saved = (!changed && !storageDirty) || persist();
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
function renderAssetRows(items) {
  renderedAssets = items;
  $('#asset-list').innerHTML = renderedAssets.map((asset, index) => `<tr class="asset-row" data-asset-index="${index}"><td><button type="button" class="asset-open" aria-haspopup="dialog" aria-label="${escapeHtml(`Export options for ${asset.name}, ${asset.meta.name}, wallet ${asset.wallet.address}`)}"><span class="asset-name"><span class="token-icon" style="--token-color:${asset.meta.color}">${escapeHtml(asset.symbol.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)} · ${escapeHtml(shortAddress(asset.wallet.address))}${asset.tokenId ? ` · #${escapeHtml(asset.tokenId)}` : ''}</small><span class="asset-open-hint">Export options ↗</span></span></span></button></td><td><span class="network-pill"><i style="background:${asset.meta.color}"></i>${asset.meta.name}</span></td><td><strong>${quantity(asset.balance)}</strong><small>${escapeHtml(asset.symbol)}</small></td><td><strong>${asset.price === null ? '—' : money(asset.balance * asset.price)}</strong><small>${asset.price === null ? (asset.nft ? 'Collectible' : 'Price unavailable') : 'USD'}</small></td></tr>`).join('');
}
function syncFileView() {
  fileScan?.setView({ assetOffset: fileAssetPage * PAGE_SIZE, walletOffset: fileWalletPage * PAGE_SIZE, network: $('#network-filter').value });
}
function renderFile() {
  const state = fileScan?.snapshot() || { hasJob: false, uploading: false, data: null, error: 'Server file import is unavailable.', view: {} };
  const data = state.data;
  $('#asset-description').textContent = 'Server-scanned file results. Select an asset to export its wallet.';
  $('#wallet-description').textContent = 'Addresses derived and scanned on EC2.';
  const count = data?.wallets || 0; const assetCount = data?.assetCount || 0; const filteredCount = data?.filteredAssetCount || 0;
  const hasView = Boolean(data && data.network === state.view.network && data.assetOffset === state.view.assetOffset && data.walletOffset === state.view.walletOffset);
  const nextAssetPage = Math.min(fileAssetPage, Math.max(0, Math.ceil(filteredCount / PAGE_SIZE) - 1));
  const nextWalletPage = Math.min(fileWalletPage, Math.max(0, Math.ceil(count / PAGE_SIZE) - 1));
  if (hasView && (nextAssetPage !== fileAssetPage || nextWalletPage !== fileWalletPage)) {
    fileAssetPage = nextAssetPage; fileWalletPage = nextWalletPage; syncFileView(); return;
  }
  const items = hasView ? data.assets.flatMap(row => {
    const asset = row.asset; const meta = networks[row.network];
    if (!meta || !classifyAddress(row.address) || !asset || typeof asset.rawBalance !== 'string' || !/^\d+$/.test(asset.rawBalance)) return [];
    const balance = amount(asset.rawBalance, asset.decimals); const nft = /ERC-721|ERC-1155/i.test(asset.type || '');
    const price = asset.price == null || asset.price === '' || !Number.isFinite(Number(asset.price)) || Number(asset.price) < 0 || nft ? null : Number(asset.price);
    return [{ ...asset, name: typeof asset.name === 'string' && asset.name ? asset.name : 'Unknown asset', symbol: typeof asset.symbol === 'string' && asset.symbol ? asset.symbol : 'UNKNOWN',
      balance, price, nft, network: row.network, meta, wallet: { address: row.address, source: 'file' }, fileJobId: state.jobId,
      remotePhraseAvailable: Boolean(data.phraseMatching && data.retainsPhrases) }];
  }) : [];
  const running = data && ['importing', 'scanning'].includes(data.status);
  const unavailableValue = !data || data.status === 'failed' || !Number.isFinite(data.knownValue) || (data.knownValue === 0 && (running || data.incomplete || data.unpriced));
  $('#total-value').textContent = unavailableValue ? '—' : money(data.knownValue);
  $('#value-note').textContent = !data ? (state.uploading ? 'Uploading to the server…' : state.hasJob ? 'Connecting to EC2…' : 'Upload a .txt file to begin') : data.status === 'failed' ? 'File processing failed' : running ? 'Partial results while EC2 scans' : data.incomplete ? 'Partial results · some checks incomplete' : data.unpriced ? `${data.unpriced} asset${data.unpriced === 1 ? '' : 's'} without a price` : 'Across this uploaded file';
  $('#wallet-count').textContent = $('#wallet-badge').textContent = count;
  $('#asset-count').textContent = assetCount; $('#asset-badge').textContent = filteredCount;
  renderAssetRows(items);
  const walletRows = hasView ? data.walletPage : [];
  $('#wallet-list').innerHTML = walletRows.map(wallet => {
    const label = wallet.completed < wallet.total ? `Scanning ${wallet.completed}/${wallet.total} networks` : wallet.incomplete ? `⚠ Incomplete · ${wallet.incomplete} checks` : wallet.hasAssets ? '✓ Scanned · assets found' : '✓ Scanned · no assets found';
    const css = wallet.incomplete ? 'incomplete' : wallet.completed === wallet.total ? 'complete' : '';
    return `<div class="wallet-row"><span class="wallet-avatar">◈</span><div class="wallet-info"><strong title="${escapeHtml(wallet.address)}">${escapeHtml(wallet.address)}</strong><span class="wallet-scan-state ${css}">${escapeHtml(label)}</span></div></div>`;
  }).join('');
  $('#wallet-empty').hidden = count > 0;
  if (!count) $('#wallet-empty').innerHTML = `<div class="wallet-illustration" aria-hidden="true">▧</div><div><strong>${state.hasJob || state.uploading ? 'No server wallets yet' : 'No file uploaded'}</strong><p>${state.hasJob || state.uploading ? 'Addresses appear as EC2 processes the file.' : 'Choose a .txt file in Add wallets.'}</p></div>`;
  updatePager('wallet', fileWalletPage, count); updatePager('asset', fileAssetPage, filteredCount);
  $('#empty-state').hidden = items.length > 0;
  if (!items.length) {
    const empty = $('#empty-state');
    empty.querySelector('h3').textContent = state.hasJob && (!data || !hasView) ? 'Loading server results' : 'No assets to show';
    empty.querySelector('p').textContent = state.uploading ? 'The file must finish uploading before EC2 can scan it.' : running ? 'EC2 is still processing the file and checking balances.' : data?.incomplete ? 'Some checks are incomplete; retry them to avoid missing assets.' : state.hasJob && (!data || !hasView) ? 'Fetching paginated results from EC2.' : state.hasJob ? 'No positive balances found for this view.' : 'Upload a .txt file to scan it on EC2.';
    empty.querySelector('button').hidden = true;
  }
  $('#remove-all').disabled = true; $('#remove-all').textContent = `Remove all wallets (${wallets.length})`;
  $('#remove-all').title = 'File results are managed with Delete file results & phrases.';
  $('#remove-zero').hidden = true; $('#zero-help').hidden = true;
  $('#refresh').disabled = !state.hasJob || state.uploading; $('#refresh').classList.toggle('spinning', Boolean(state.loading));
  $('#scan-progress').hidden = !(state.hasJob || state.uploading || state.error);
  const percentage = state.uploading ? state.uploadPercent : data?.total ? Math.round(data.completed / data.total * 100) : data?.status === 'finished' ? 100 : 0;
  $('#progress-text').textContent = state.uploading ? 'Uploading file to EC2…' : !data ? (state.error ? 'Server connection unavailable' : 'Connecting to EC2…') : data.status === 'importing' ? 'Processing file on EC2…' : data.status === 'scanning' ? 'Checking balances on EC2…' : data.status === 'failed' ? 'Server file processing failed' : data.incomplete ? 'Server scan finished with incomplete checks' : 'Server scan complete';
  $('#progress-percent').textContent = `${percentage}%`; $('#progress-bar').value = percentage;
  $('#progress-detail').textContent = state.uploading ? 'Keep this laptop on until the upload is confirmed. EC2 continues scanning after confirmation.' : data ? `${data.wallets.toLocaleString()} wallets · ${data.completed.toLocaleString()} of ${data.total.toLocaleString()} network checks · ${data.incomplete.toLocaleString()} incomplete${data.invalid ? ` · ${data.invalid.toLocaleString()} invalid lines` : ''}` : state.hasJob ? 'Job credentials are stored in this browser for reconnection.' : 'No file is being processed locally.';
  const error = state.error || (data?.status === 'failed' ? (data.error || 'Server processing failed.') : '') || (state.storageWarning ? 'Browser storage failed. Keep this page open or access to this job may be lost.' : '');
  $('#scan-errors').hidden = !error; $('#scan-errors').textContent = error;
  $('#scan-status').hidden = !error; $('#scan-status').textContent = error;
  $('#retry-failed').hidden = !(data?.status === 'finished' && data.incomplete > 0); $('#retry-failed').disabled = false; $('#retry-failed').textContent = 'Retry incomplete checks';
  $('#file-remove').hidden = !data || !['finished', 'failed'].includes(data.status);
}
let sourceOptionsKey = '';
function renderPortfolioSource() {
  const state = fileScan?.snapshot() || { jobs: [], jobId: null, uploading: false };
  const select = $('#portfolio-source');
  const key = `${state.jobs.map(item => item.id).join(',')}:${state.uploading}`;
  if (key !== sourceOptionsKey) {
    select.replaceChildren();
    const watch = document.createElement('option'); watch.value = 'watch'; watch.textContent = 'Tracked addresses'; select.appendChild(watch);
    state.jobs.forEach((item, index) => {
      const option = document.createElement('option'); option.value = `file:${item.id}`; option.textContent = `Uploaded file ${index + 1}`;
      option.disabled = state.uploading; select.appendChild(option);
    });
    if (state.uploading || !state.jobId) {
      const option = document.createElement('option'); option.value = 'file:new'; option.textContent = state.uploading ? 'Uploading file…' : 'Uploaded file'; select.appendChild(option);
    }
    sourceOptionsKey = key;
  }
  select.value = viewMode === 'watch' ? 'watch' : state.jobId ? `file:${state.jobId}` : 'file:new';
}
function render() {
  renderPortfolioSource();
  if (viewMode === 'file') return renderFile();
  $('#asset-description').textContent = 'Balances across your tracked wallets. Select an asset to export its wallet.';
  $('#wallet-description').textContent = 'Your tracked addresses.';
  $('#file-remove').hidden = true;
  $('#remove-all').title = 'Remove all watch-list entries';
  $('#retry-failed').textContent = 'Retry failed checks';
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
  if (!wallets.length) $('#wallet-empty').innerHTML = '<div class="wallet-illustration" aria-hidden="true">▧</div><div><strong>No wallets added</strong><p>Addresses you add will appear here.</p></div>';
  walletPage = Math.min(walletPage, Math.max(0, Math.ceil(wallets.length / PAGE_SIZE) - 1));
  assetPage = Math.min(assetPage, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  $('#wallet-list').innerHTML = wallets.slice(walletPage * PAGE_SIZE, (walletPage + 1) * PAGE_SIZE).map(wallet => { const state = walletScanLabel(wallet); return `<div class="wallet-row"><span class="wallet-avatar">◈</span><div class="wallet-info"><strong title="${escapeHtml(wallet.address)}">${escapeHtml(wallet.address)}</strong><span class="wallet-scan-state ${state.css}">${escapeHtml(state.label)}</span></div><button class="remove-wallet" data-address="${escapeHtml(wallet.address)}" aria-label="Remove ${escapeHtml(wallet.address)}" title="Remove wallet">×</button></div>`; }).join('');
  renderAssetRows(visible.slice(assetPage * PAGE_SIZE, (assetPage + 1) * PAGE_SIZE));
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
  status.textContent = pending ? `Scanning ${pending} wallet network${pending === 1 ? '' : 's'}…` : `${failed} wallet network${failed === 1 ? '' : 's'} had incomplete or failed checks. Retry to recover missing data.`;
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
    for (const check of failedChecks.values()) {
      const reasons = counts[check.network] ||= {};
      reasons[check.reason] = (reasons[check.reason] || 0) + 1;
    }
    const explanations = { limited: 'Rate limiting detected', invalid: 'Invalid or incomplete indexer data', unavailable: 'Indexer or network unavailable', partial: 'Native balance only; token and NFT data unavailable' };
    const details = Object.entries(counts).map(([network, reasons]) => {
      const count = Object.values(reasons).reduce((sum, value) => sum + value, 0);
      const breakdown = Object.entries(reasons).map(([reason, number]) => `${explanations[reason]} (${number})`).join('; ');
      return `${networks[network].name}: ${count} — ${breakdown}`;
    }).join(' · ');
    errorDetails.textContent = `${details}. Failed checks are not treated as zero.`;
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
  watchInitialized = true;
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
    // A partial native-only result may have contributed assets. Remove those
    // before retrying so a successful retry cannot double-count them.
    const retryKeys = new Set(retryTasks.map(({ wallet, network }) => `${keyFor(wallet.address)}:${network}`));
    scanData.assets = scanData.assets.filter(asset => !retryKeys.has(`${keyFor(asset.wallet.address)}:${asset.network}`));
    scanData.knownValue = scanData.assets.reduce((total, asset) => total + (asset.price === null ? 0 : asset.balance * asset.price), 0);
    scanData.unpriced = scanData.assets.filter(asset => asset.price === null).length;
    const walletsWithAssets = new Set(scanData.assets.map(asset => keyFor(asset.wallet.address)));
    scanData.completed -= retryTasks.length;
    scanData.failed -= retryTasks.length;
    for (const { wallet } of retryTasks) {
      const state = walletStates.get(keyFor(wallet.address));
      if (state) { state.done--; state.failed--; state.hasAssets = walletsWithAssets.has(keyFor(wallet.address)); }
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
              // The server may be unable to reach an indexer that the browser
              // can access. Prefer full indexed results over a native-only RPC.
              if (data.coverage === 'native-only' && !nativeOnlyNetworks.has(network)) {
                try {
                  const direct = await scanDirect(address, network, directFetcher);
                  if (Array.isArray(direct.assets) && direct.coverage !== 'native-only') data = direct;
                } catch (_) { /* Retain the verified server-side native balance. */ }
                if (signal.aborted) return;
              }
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
          const partial = data.coverage === 'native-only' && !nativeOnlyNetworks.has(network);
          if (partial) {
            scanData.failed++;
            failedChecks.set(`${keyFor(address)}:${network}`, { wallet, network, reason: 'partial' });
          }
          recordWalletScan(wallet, hasAssets, partial, network);
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
function matchingCustodyJson(key) {
  try {
    const json = localStorage.getItem('walleto.encrypted-wallet.v1');
    if (!json) return null;
    const savedAddress = JSON.parse(json).address;
    if (typeof savedAddress !== 'string') return null;
    const address = savedAddress.startsWith('0x') ? savedAddress : `0x${savedAddress}`;
    return keyFor(address) === key ? json : null;
  } catch (_) { return null; }
}
function hideExportPhrase() {
  exportVisibilityVersion++;
  if (activeExport?.remote) activeExport.remotePhrase = null;
  $('#asset-export-phrase').textContent = activeExport?.remote ? 'Stored on EC2 — reveal only in a private place' : 'Hidden — reveal only in a private place';
  $('#asset-export-reveal').textContent = 'Reveal phrase';
  $('#asset-export-reveal').setAttribute('aria-expanded', 'false');
}
function closeAssetExport(restoreFocus = true) {
  const dialog = $('#asset-export-dialog');
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  let opener = exportOpener;
  if (restoreFocus && !opener?.isConnected && activeExport) {
    const index = renderedAssets.findIndex(asset => keyFor(asset.wallet.address) === activeExport.key);
    if (index >= 0) opener = $(`#asset-list [data-asset-index="${index}"] .asset-open`);
  }
  activeExport = null; exportOpener = null;
  hideExportPhrase();
  $('#asset-export-phrase').textContent = '';
  $('#asset-export-address').textContent = '';
  $('#asset-export-unlock').hidden = true;
  $('#asset-export-password').value = '';
  $('#asset-export-unlock-button').disabled = false;
  $('#asset-export-reveal').disabled = false; $('#asset-export-download').disabled = false;
  $('#asset-export-unlock-status').hidden = true;
  $('#asset-export-unlock-status').textContent = '';
  $('#asset-export-status').hidden = true;
  $('#asset-export-status').textContent = '';
  if (restoreFocus && opener?.isConnected) opener.focus();
}
function openAssetExport(asset, opener) {
  const key = keyFor(asset.wallet.address); const isFile = Boolean(asset.fileJobId);
  const fileState = isFile ? fileScan?.snapshot() : null;
  const wallet = isFile && fileState?.jobId === asset.fileJobId ? asset.wallet : wallets.find(item => keyFor(item.address) === key);
  if (!key || !wallet || (isFile && fileState?.jobId !== asset.fileJobId)) return;
  if ($('#asset-export-dialog').open) closeAssetExport(false);
  const remote = isFile && asset.remotePhraseAvailable;
  const includePhrase = remote || sessionPhrases.has(key);
  const custodyJson = includePhrase ? null : matchingCustodyJson(key);
  activeExport = { address: wallet.address, key, includePhrase, custodyJson, unlocking: false, source: isFile ? 'file' : 'watch', fileJobId: asset.fileJobId || null, remote, remotePhrase: null };
  exportOpener = opener;
  $('#asset-export-description').textContent = `${asset.name} on ${asset.meta.name} · ${quantity(asset.balance)} ${asset.symbol}`;
  $('#asset-export-address').textContent = wallet.address;
  $('#asset-export-phrase-block').hidden = !includePhrase;
  $('#asset-export-unlock').hidden = !custodyJson;
  $('#asset-export-password').value = '';
  $('#asset-export-unlock-button').disabled = false;
  $('#asset-export-reveal').disabled = false; $('#asset-export-download').disabled = false;
  $('#asset-export-unlock-status').hidden = true;
  $('#asset-export-unlock-status').textContent = '';
  hideExportPhrase();
  $('#asset-export-note').textContent = remote
    ? 'The recovery phrase is retained on EC2 and is retrieved over the private tunnel only when you reveal or export it.'
    : includePhrase ? 'The export includes this wallet address and its recovery phrase, which is available only in this tab.'
    : isFile ? (custodyJson ? 'This server job has no retained phrase. Unlock the matching wallet below or export only the address.' : 'This server job has no retained phrase for export. Only the public address is available.')
    : wallet.source === 'seed'
      ? (custodyJson ? 'This imported phrase is no longer in this tab. Unlock the matching wallet below or re-import the phrase to include it; otherwise only the public address is exported.' : 'This wallet was imported from a recovery phrase, but phrases are not saved after leaving or reloading. Re-import it to include the phrase, or export only the public address.')
      : custodyJson ? 'Only the public address is available until you unlock the matching self-custody wallet below.' : 'Only the public address is available. If this wallet was previously imported from a recovery phrase, re-import it in this tab to include the phrase.';
  $('#asset-export-download').textContent = includePhrase ? 'Export' : 'Export address only';
  $('#asset-export-status').hidden = true;
  $('#asset-export-status').textContent = '';
  const dialog = $('#asset-export-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  $('#asset-export-close').focus();
}
$('#asset-list').addEventListener('click', event => {
  const row = event.target.closest('tr[data-asset-index]');
  if (!row || !$('#asset-list').contains(row)) return;
  const asset = renderedAssets[Number(row.dataset.assetIndex)];
  if (asset) openAssetExport(asset, row.querySelector('.asset-open'));
});
$('#asset-export-close').addEventListener('click', () => closeAssetExport());
$('#asset-export-cancel').addEventListener('click', () => closeAssetExport());
$('#asset-export-dialog').addEventListener('cancel', event => { event.preventDefault(); closeAssetExport(); });
$('#asset-export-dialog').addEventListener('close', () => { if (!$('#asset-export-dialog').open && activeExport) closeAssetExport(); });
$('#asset-export-reveal').addEventListener('click', async () => {
  const current = activeExport;
  if (!current?.includePhrase) return;
  const show = $('#asset-export-reveal').getAttribute('aria-expanded') !== 'true';
  if (!show) { hideExportPhrase(); return; }
  const visibility = ++exportVisibilityVersion; const version = phraseSessionVersion;
  try {
    let phrase;
    if (current.remote) {
      $('#asset-export-reveal').disabled = true;
      phrase = await fileScan.phrase(current.address, current.fileJobId);
      if (activeExport !== current || version !== phraseSessionVersion || visibility !== exportVisibilityVersion) return;
      current.remotePhrase = phrase;
    } else phrase = sessionPhrases.get(current.key);
    if (!phrase || activeExport !== current) return;
    $('#asset-export-phrase').textContent = phrase;
    $('#asset-export-reveal').textContent = 'Hide phrase';
    $('#asset-export-reveal').setAttribute('aria-expanded', 'true');
  } catch (_) {
    if (activeExport === current && version === phraseSessionVersion && visibility === exportVisibilityVersion) {
      $('#asset-export-status').textContent = 'Could not retrieve a verified recovery phrase from EC2. Reconnect the private tunnel and try again.';
      $('#asset-export-status').hidden = false;
    }
  } finally { if (activeExport === current) $('#asset-export-reveal').disabled = false; }
});
$('#asset-export-unlock').addEventListener('submit', async event => {
  event.preventDefault();
  const current = activeExport;
  if (!current?.custodyJson || current.unlocking) return;
  const password = $('#asset-export-password').value;
  $('#asset-export-password').value = '';
  if (!password) return;
  current.unlocking = true;
  $('#asset-export-unlock-button').disabled = true;
  $('#asset-export-unlock-status').hidden = false;
  $('#asset-export-unlock-status').textContent = 'Unlocking on this device…';
  const version = phraseSessionVersion;
  try {
    if (matchingCustodyJson(current.key) !== current.custodyJson) throw new Error('Wallet changed');
    const account = await window.unlockCustodyRecoveryPhrase(current.custodyJson, password);
    if (activeExport !== current || version !== phraseSessionVersion) return;
    if (matchingCustodyJson(current.key) !== current.custodyJson || keyFor(account.address) !== current.key || typeof account.phrase !== 'string') throw new Error('Wallet changed');
    sessionPhrases.set(current.key, account.phrase);
    current.includePhrase = true; current.custodyJson = null;
    $('#asset-export-phrase-block').hidden = false;
    $('#asset-export-unlock').hidden = true;
    hideExportPhrase();
    $('#asset-export-note').textContent = 'The export includes this wallet address and its recovery phrase, which is available only in this tab.';
    $('#asset-export-download').textContent = 'Export';
    $('#asset-export-status').hidden = true;
    $('#asset-export-status').textContent = '';
    $('#asset-export-reveal').focus();
  } catch (_) {
    if (activeExport === current && version === phraseSessionVersion) {
      $('#asset-export-unlock-status').textContent = 'Could not unlock the matching wallet or its recovery phrase. Check the password and try again.';
      $('#asset-export-password').focus();
    }
  } finally {
    current.unlocking = false;
    if (activeExport === current) $('#asset-export-unlock-button').disabled = false;
  }
});
$('#asset-export-download').addEventListener('click', async () => {
  const current = activeExport;
  if (!current) return;
  if (current.includePhrase && !confirm('This text file will contain your unencrypted recovery phrase. Anyone who can access it can control your funds. Only export to a device and location you trust. Continue?')) return;
  const version = phraseSessionVersion; const visibility = exportVisibilityVersion;
  let phrase = null; let phrasePrepared = false;
  try {
    if (current.includePhrase && current.remote) {
      $('#asset-export-download').disabled = true;
      phrase = current.remotePhrase || await fileScan.phrase(current.address, current.fileJobId);
      if (activeExport !== current || version !== phraseSessionVersion || visibility !== exportVisibilityVersion || fileScan.snapshot().jobId !== current.fileJobId) return;
    } else if (current.includePhrase) phrase = sessionPhrases.get(current.key);
    if (current.includePhrase && !phrase) {
      $('#asset-export-status').textContent = 'The recovery phrase is no longer available. Re-import it to export the phrase.';
      $('#asset-export-status').hidden = false;
      return;
    }
    phrasePrepared = true;
    const text = phrase ? `Wallet address: ${current.address}\nRecovery phrase: ${phrase}\n` : `${current.address}\n`;
    let url; let link;
    try {
      url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      pendingExportUrls.add(url);
      link = document.createElement('a');
      link.href = url; link.download = 'walleto-wallet.txt';
      document.body.appendChild(link); link.click();
      $('#asset-export-status').textContent = phrase ? 'Export started. Protect the unencrypted file and never share it.' : 'Public address export started.';
      $('#asset-export-status').hidden = false;
    } finally {
      if (link) link.remove();
      if (url) setTimeout(() => { if (pendingExportUrls.delete(url)) URL.revokeObjectURL(url); }, 1000);
    }
  } catch (_) {
    if (activeExport === current && version === phraseSessionVersion) {
      $('#asset-export-status').textContent = current.remote && !phrasePrepared ? 'Could not retrieve a verified recovery phrase from EC2. Reconnect the private tunnel and try again.' : 'Could not start the export. Try a browser that supports file downloads.';
      $('#asset-export-status').hidden = false;
    }
  } finally { if (activeExport === current) $('#asset-export-download').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && activeExport) hideExportPhrase(); });
window.addEventListener('pagehide', () => {
  phraseSessionVersion++;
  if (pendingPhraseImport) pendingPhraseImport.clear();
  sessionPhrases.clear();
  for (const url of pendingExportUrls) URL.revokeObjectURL(url);
  pendingExportUrls.clear();
  closeAssetExport(false);
});
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
  viewMode = 'watch'; if (!watchInitialized) scan(); else render();
  field.value = '';
  importStatus(!result.saved ? 'Address tracked for this session, but browser storage is unavailable.' : result.duplicates ? 'This address is already being tracked.' : 'Address added. Scanning balances…', !result.saved);
});
$('#generate-phrase').addEventListener('click', () => {
  try {
    const phrase = window.generateWatchPhrase();
    const field = $('#seed-phrases');
    // Preserve any pasted phrases; each click appends one complete phrase.
    const existing = field.value;
    field.value = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + phrase;
    field.focus();
    importStatus('Generated one 12-word phrase locally. Click Add pasted phrases to track its first EVM address. The input will be cleared; the phrase remains in this tab for export until you leave or reload.');
  } catch (_) {
    importStatus('Could not generate a phrase: secure randomness is unavailable. Try a trusted, up-to-date browser.', true);
  }
});
$('#seed-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#seed-form button[type="submit"]');
  if (submit.disabled) return;
  const pasted = $('#seed-phrases').value;
  // Pasted text is the only input accepted by this local derivation path.
  $('#seed-phrases').value = '';
  if (!pasted.trim()) return importStatus('Paste a seed phrase. Selected .txt files are uploaded separately to EC2.', true);
  submit.disabled = true;
  const importVersion = phraseSessionVersion;
  const importedPhrases = new Map();
  pendingPhraseImport = importedPhrases;
  try {
    const checkSession = () => { if (importVersion !== phraseSessionVersion) throw new Error('Import interrupted'); };
    const rememberPhrase = (address, phrase) => {
      checkSession();
      const key = keyFor(address);
      if (key) importedPhrases.set(key, phrase);
    };
    importStatus('Processing pasted text locally…');
    const updateProgress = (done, total) => { checkSession(); importStatus(`Processing pasted text: ${total ? Math.floor(done * 100 / total) : 100}%…`); };
    const result = await window.deriveWatchAddresses(pasted, updateProgress, rememberPhrase);
    checkSession();
    const problems = [];
    if (result.invalid.length) {
      const shown = result.invalid.slice(0, 20).join(', ');
      const extra = result.invalidCount > 20 ? ` and ${result.invalidCount - 20} more` : '';
      problems.push(`Pasted text: invalid line${result.invalid.length === 1 ? '' : 's'} ${shown}${extra}`);
    }
    const { added, duplicates, saved } = addAddresses(result.addresses, 'seed');
    for (const [key, phrase] of importedPhrases) sessionPhrases.set(key, phrase);
    viewMode = 'watch'; if (!watchInitialized) scan(); else render();
    const parts = [`${added} wallet${added === 1 ? '' : 's'} added`, ...(duplicates ? [`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`] : []), ...problems];
    if (!saved) parts.push('Browser storage is full or unavailable; wallet changes will only last this session');
    if (!result.addresses.length && !problems.length) parts.push('No phrases found');
    const next = importedPhrases.size
      ? `${importedPhrases.size} recovery phrase${importedPhrases.size === 1 ? '' : 's'} available for export in this tab until you leave or reload.${added ? ' Scanning balances…' : ''}`
      : 'Use one complete valid phrase per line.';
    importStatus(`${parts.join(' · ')}. ${next}`, !saved || problems.length > 0 || !result.addresses.length);
  } catch (_) {
    importStatus(importVersion !== phraseSessionVersion ? 'Import interrupted. Re-import the phrases if needed.' : 'Could not process the pasted text. Use one valid phrase per line.', true);
  } finally {
    importedPhrases.clear();
    if (pendingPhraseImport === importedPhrases) pendingPhraseImport = null;
    submit.disabled = false;
  }
});
function cancelPendingPhraseImport() {
  if (!pendingPhraseImport) return;
  phraseSessionVersion++;
  pendingPhraseImport.clear();
}
$('#wallet-list').addEventListener('click', event => {
  const button = event.target.closest('[data-address]');
  if (!button) return;
  const removed = keyFor(button.dataset.address);
  if (!removed) return;
  cancelPendingPhraseImport();
  sessionPhrases.delete(removed);
  if (activeExport?.key === removed) closeAssetExport(false);
  wallets = wallets.filter(wallet => keyFor(wallet.address) !== removed);
  const saved = persist(); scan();
  if (!saved) importStatus('The removal could not be saved in browser storage.', true);
});
$('#remove-all').addEventListener('click', () => {
  const count = wallets.length;
  if (!count || !confirm(`Remove all ${count} wallet${count === 1 ? '' : 's'} from the watch list? Any ongoing balance scan will stop. This does not delete your wallets or funds.`)) return;
  cancelPendingPhraseImport();
  sessionPhrases.clear();
  if (activeExport) closeAssetExport(false);
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
  cancelPendingPhraseImport();
  const removedChecks = wallets.filter(wallet => zeroWallets.has(keyFor(wallet.address))).reduce((sum, wallet) => sum + networksFor(wallet.address).length, 0);
  wallets = wallets.filter(wallet => !zeroWallets.has(keyFor(wallet.address)));
  if (activeExport && zeroWallets.has(activeExport.key)) closeAssetExport(false);
  for (const address of zeroWallets) { walletStates.delete(address); sessionPhrases.delete(address); }
  zeroWallets.clear();
  scanData.total -= removedChecks;
  scanData.completed -= removedChecks;
  const saved = persist(); render();
  importStatus(saved ? `Removed ${count} zero-balance wallet${count === 1 ? '' : 's'} from the watch list.` : `Removed ${count} wallet${count === 1 ? '' : 's'} for this session, but browser storage could not save the change.`, !saved);
});
$('#portfolio-source').addEventListener('change', event => {
  const selected = event.target.value;
  viewMode = selected === 'watch' ? 'watch' : 'file';
  if (viewMode === 'file') {
    fileAssetPage = 0; fileWalletPage = 0; $('#network-filter').value = 'all';
    if (selected.startsWith('file:') && selected !== 'file:new') fileScan?.select(selected.slice(5));
    syncFileView();
  }
  if (viewMode === 'watch' && !watchInitialized) scan(); else render();
});
window.addEventListener('file-scan:started', () => {
  // Do not keep an unrelated foreground watch-list scan running when a file
  // job starts. It is restarted only if the user returns to that view.
  if (loading) {
    scanController?.abort(); scanVersion++; loading = false; watchInitialized = false;
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  }
  viewMode = 'file'; fileAssetPage = 0; fileWalletPage = 0; $('#network-filter').value = 'all'; render();
});
window.addEventListener('file-scan:update', () => {
  if (activeExport?.source === 'file' && fileScan?.snapshot().jobId !== activeExport.fileJobId) closeAssetExport(false);
  if (viewMode === 'file') render(); else renderPortfolioSource();
});
$('#network-filter').addEventListener('change', () => {
  if (viewMode === 'file') { fileAssetPage = 0; syncFileView(); } else assetPage = 0;
  render();
});
$('#wallet-prev').addEventListener('click', () => { if (viewMode === 'file') { fileWalletPage--; syncFileView(); } else walletPage--; render(); });
$('#wallet-next').addEventListener('click', () => { if (viewMode === 'file') { fileWalletPage++; syncFileView(); } else walletPage++; render(); });
$('#asset-prev').addEventListener('click', () => { if (viewMode === 'file') { fileAssetPage--; syncFileView(); } else assetPage--; render(); });
$('#asset-next').addEventListener('click', () => { if (viewMode === 'file') { fileAssetPage++; syncFileView(); } else assetPage++; render(); });
$('#refresh').addEventListener('click', () => { if (viewMode === 'file') fileScan?.refresh(); else scan(); });
$('#retry-failed').addEventListener('click', () => { if (viewMode === 'file') fileScan?.retry(); else scan(true); });
$('#file-remove').addEventListener('click', async () => { if (await fileScan?.remove()) { fileAssetPage = 0; fileWalletPage = 0; $('#network-filter').value = 'all'; viewMode = fileScan.snapshot().hasJob ? 'file' : 'watch'; if (viewMode === 'watch' && !watchInitialized) scan(); else render(); } });
$('#today').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
if (viewMode === 'watch') scan(); else render();
