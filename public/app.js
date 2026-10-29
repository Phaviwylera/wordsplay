const networks = {
  ethereum: { name: 'Ethereum', short: 'ETH', color: '#627eea' }, base: { name: 'Base', short: 'B', color: '#1652f0' },
  arbitrum: { name: 'Arbitrum', short: 'A', color: '#28a0f0' }, optimism: { name: 'Optimism', short: 'OP', color: '#ff0420' },
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const shortAddress = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;
let wallets = [];
try {
  const saved = JSON.parse(localStorage.getItem('walleto.wallets') || '[]');
  if (Array.isArray(saved)) wallets = saved.filter(w => typeof w.address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(w.address)).map(w => ({ address: w.address }));
} catch (_) { /* Storage may be unavailable. */ }
let scanData = { total: 0, completed: 0, failed: 0, assets: [], knownValue: 0, unpriced: 0 };
let walletPage = 0;
let assetPage = 0;
const PAGE_SIZE = 100;
let scanVersion = 0;
let loading = false;
let scanController = null;
let renderTimer = null;
function persist() { try { localStorage.setItem('walleto.wallets', JSON.stringify(wallets)); return true; } catch (_) { return false; } }
function importStatus(text, error = false) { const el = $('#import-status'); el.textContent = text; el.hidden = false; el.classList.toggle('error', error); }
function addAddresses(addresses) {
  let added = 0; let duplicates = 0;
  const seen = new Set(wallets.map(wallet => wallet.address.toLowerCase()));
  for (const address of addresses) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) { duplicates++; continue; }
    seen.add(normalized); wallets.push({ address }); added++;
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
function quantity(value) { return value > 0 && value < 0.000001 ? '<0.000001' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value); }
function updatePager(prefix, page, count) {
  const pager = $(`#${prefix}-pager`);
  pager.hidden = count <= PAGE_SIZE;
  $(`#${prefix}-page-label`).textContent = `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, count)} of ${count}`;
  $(`#${prefix}-prev`).disabled = page === 0;
  $(`#${prefix}-next`).disabled = (page + 1) * PAGE_SIZE >= count;
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
  $('#wallet-list').innerHTML = wallets.slice(walletPage * PAGE_SIZE, (walletPage + 1) * PAGE_SIZE).map(wallet => `<div class="wallet-row"><span class="wallet-avatar">◈</span><div class="wallet-info"><strong title="${escapeHtml(wallet.address)}">${escapeHtml(wallet.address)}</strong><span>Watch-only address</span></div><button class="remove-wallet" data-address="${escapeHtml(wallet.address)}" aria-label="Remove ${escapeHtml(wallet.address)}" title="Remove wallet">×</button></div>`).join('');
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
    empty.querySelector('h3').textContent = 'Nothing here just yet.';
    empty.querySelector('p').innerHTML = 'Add a wallet address and we’ll bring your<br>assets together right here.';
    empty.querySelector('button').hidden = false;
  }
  const status = $('#scan-status');
  status.hidden = !wallets.length || (!failed && !pending);
  status.textContent = pending ? `Scanning ${pending} wallet network${pending === 1 ? '' : 's'}…` : `${failed} wallet network${failed === 1 ? '' : 's'} could not be scanned. Results may be incomplete. Use refresh to try again.`;
  $('#refresh').classList.toggle('spinning', loading);
  $('#refresh').disabled = loading || !wallets.length;
}
// Keep requests bounded for large imports. Cancel the previous scan when the
// tracked address list changes, and never send recovery phrases to an indexer.
async function scanRequest(url, options, signal, timeout) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, wallets.length > 1000 ? 1000 : 150);
}
async function scan() {
  if (scanController) scanController.abort();
  scanController = new AbortController();
  const signal = scanController.signal;
  const version = ++scanVersion;
  const scanWallets = wallets.slice();
  const networkKeys = Object.keys(networks);
  scanData = { total: scanWallets.length * networkKeys.length, completed: 0, failed: 0, assets: [], knownValue: 0, unpriced: 0 };
  loading = scanData.total > 0; render();
  let next = 0;
  async function worker() {
    while (!signal.aborted && next < scanData.total) {
      const task = next++;
      const wallet = scanWallets[Math.floor(task / networkKeys.length)];
      const network = networkKeys[task % networkKeys.length];
      const address = wallet.address;
      try {
        let data;
        try {
          const response = await scanRequest(`/api/scan?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}`, {}, signal, 17000);
          if (!response.ok) throw new Error('Server scan failed');
          data = await response.json();
          if (!Array.isArray(data.assets)) throw new Error('Invalid response');
        } catch (error) {
          if (signal.aborted) return;
          data = await scanDirect(address, network, (url, options) => scanRequest(url, options, signal, 15000));
        }
        if (version === scanVersion && !signal.aborted) {
          for (const asset of data.assets) {
            const balance = amount(asset.rawBalance, asset.decimals);
            if (balance <= 0) continue;
            const nft = /ERC-721|ERC-1155/i.test(asset.type);
            const price = asset.price !== null && asset.price !== '' && Number.isFinite(Number(asset.price)) && Number(asset.price) >= 0 && !nft ? Number(asset.price) : null;
            scanData.assets.push({ ...asset, balance, price, nft, network, meta: networks[network], wallet });
            if (price === null) scanData.unpriced++; else scanData.knownValue += balance * price;
          }
          scanData.completed++;
        }
      } catch (_) {
        if (version === scanVersion && !signal.aborted) { scanData.failed++; scanData.completed++; }
      }
      if (version === scanVersion && !signal.aborted) scheduleRender();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, scanData.total) }, worker));
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
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return importStatus('Enter a valid 0x address with 40 hexadecimal characters.', true);
  const result = addAddresses([address]);
  field.value = '';
  importStatus(result.duplicates ? 'This address is already being tracked.' : result.saved ? 'Address added. Scanning balances…' : 'Address added for this session, but browser storage is unavailable.', !result.saved);
});
$('#seed-file').addEventListener('change', () => {
  // Do not display the file name: it might itself contain sensitive information.
  $('#file-name').textContent = $('#seed-file').files.length ? 'Text file selected' : 'No file selected';
});
function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsText(file, 'UTF-8');
  });
}
$('#seed-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#seed-form button[type="submit"]');
  if (submit.disabled) return;
  const pasted = $('#seed-phrases').value;
  const file = $('#seed-file').files[0];
  // Clear visible secrets and file selection immediately, including on errors.
  $('#seed-phrases').value = ''; $('#seed-file').value = ''; $('#file-name').textContent = 'No file selected';
  if (!pasted.trim() && !file) return importStatus('Paste a seed phrase or choose a .txt file.', true);
  if (pasted.length > 256 * 1024) return importStatus('Keep pasted text at or below 256 KiB.', true);
  if (file && (!/\.txt$/i.test(file.name) || file.size > 25 * 1024 * 1024)) return importStatus('Choose a .txt file at or below 25 MiB.', true);
  submit.disabled = true;
  try {
    const sources = [];
    if (pasted.trim()) sources.push({ label: 'Pasted text', text: pasted });
    if (file) sources.push({ label: 'Text file', text: await readTextFile(file) });
    const addresses = []; const problems = [];
    for (const source of sources) {
      importStatus(`Processing ${source.label.toLowerCase()} locally…`);
      const result = await window.deriveWatchAddresses(source.text, (done, total) => importStatus(`Processing ${source.label.toLowerCase()}: ${Math.floor(done * 100 / total)}%…`));
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
  wallets = wallets.filter(wallet => wallet.address.toLowerCase() !== button.dataset.address.toLowerCase());
  const saved = persist(); scan();
  if (!saved) importStatus('The removal could not be saved in browser storage.', true);
});
$('#network-filter').addEventListener('change', () => { assetPage = 0; render(); });
$('#wallet-prev').addEventListener('click', () => { walletPage--; render(); });
$('#wallet-next').addEventListener('click', () => { walletPage++; render(); });
$('#asset-prev').addEventListener('click', () => { assetPage--; render(); });
$('#asset-next').addEventListener('click', () => { assetPage++; render(); });
$('#refresh').addEventListener('click', scan);
$('#today').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
scan();
