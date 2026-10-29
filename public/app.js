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
  if (Array.isArray(saved)) wallets = saved.filter(w => typeof w.address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(w.address)).map(w => ({ address: w.address, name: typeof w.name === 'string' ? w.name.slice(0, 40) : '' }));
} catch (_) { /* Storage may be unavailable. */ }
let results = {};
let scanVersion = 0;
let loading = false;
const dialog = $('#wallet-dialog');
const form = $('#wallet-form');
const key = (address, network) => `${address.toLowerCase()}:${network}`;
function persist() { try { localStorage.setItem('walleto.wallets', JSON.stringify(wallets)); } catch (_) { $('#form-error').textContent = 'Your browser could not save this wallet. It will only be available for this session.'; } }
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
function render() {
  const selected = $('#network-filter').value;
  const items = [];
  let failed = 0; let pending = 0; let succeeded = 0;
  for (const wallet of wallets) for (const [network, meta] of Object.entries(networks)) {
    const result = results[key(wallet.address, network)];
    if (!result || result.status === 'loading') { pending++; continue; }
    if (result.status === 'error') { failed++; continue; }
    succeeded++;
    for (const asset of result.assets) {
      const balance = amount(asset.rawBalance, asset.decimals);
      if (balance <= 0) continue;
      const nft = /ERC-721|ERC-1155/i.test(asset.type);
      const price = asset.price !== null && asset.price !== '' && Number.isFinite(Number(asset.price)) && Number(asset.price) >= 0 && !nft ? Number(asset.price) : null;
      items.push({ ...asset, balance, price, nft, network, meta, wallet });
    }
  }
  const visible = items.filter(a => selected === 'all' || a.network === selected);
  const knownValue = items.reduce((sum, a) => sum + (a.price === null ? 0 : a.balance * a.price), 0);
  const unpriced = items.filter(a => a.price === null).length;
  // Do not mistake an unavailable scan or entirely unpriced assets for a zero balance.
  const noReliableTotal = wallets.length && ((!succeeded) || (knownValue === 0 && (failed || pending || unpriced)));
  $('#total-value').textContent = noReliableTotal ? '—' : money(knownValue);
  $('#value-note').textContent = !wallets.length ? 'Add a wallet to get started' : pending ? 'Scanning your wallets…' : failed ? (succeeded ? 'Partial results · some networks unavailable' : 'Balance unavailable · scan failed') : unpriced ? `${unpriced} asset${unpriced === 1 ? '' : 's'} without a price` : 'Across all your wallets';
  $('#wallet-count').textContent = $('#wallet-badge').textContent = wallets.length;
  $('#asset-count').textContent = items.length;
  $('#asset-badge').textContent = visible.length;
  $('#wallet-empty').hidden = wallets.length > 0;
  $('#wallet-list').innerHTML = wallets.map((wallet, index) => `<div class="wallet-row"><span class="wallet-avatar">${escapeHtml((wallet.name || 'W').charAt(0).toUpperCase())}</span><div class="wallet-info"><strong>${escapeHtml(wallet.name || `Wallet ${index + 1}`)}</strong><span>${escapeHtml(shortAddress(wallet.address))}</span></div><button class="remove-wallet" data-address="${escapeHtml(wallet.address)}" aria-label="Remove ${escapeHtml(wallet.name || 'wallet')}" title="Remove wallet">×</button></div>`).join('');
  $('#asset-list').innerHTML = visible.map(asset => `<tr><td><div class="asset-name"><span class="token-icon" style="--token-color:${asset.meta.color}">${escapeHtml(asset.symbol.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)} · ${escapeHtml(asset.wallet.name || shortAddress(asset.wallet.address))}${asset.tokenId ? ` · #${escapeHtml(asset.tokenId)}` : ''}</small></span></div></td><td><span class="network-pill"><i style="background:${asset.meta.color}"></i>${asset.meta.name}</span></td><td><strong>${quantity(asset.balance)}</strong><small>${escapeHtml(asset.symbol)}</small></td><td><strong>${asset.price === null ? '—' : money(asset.balance * asset.price)}</strong><small>${asset.price === null ? (asset.nft ? 'Collectible' : 'Price unavailable') : 'USD'}</small></td></tr>`).join('');
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
async function scan() {
  const version = ++scanVersion;
  const tasks = [];
  results = {};
  for (const wallet of wallets) for (const network of Object.keys(networks)) {
    const resultKey = key(wallet.address, network);
    results[resultKey] = { status: 'loading' };
    tasks.push((async () => {
      try {
        let data;
        try {
          const response = await fetch(`/api/scan?address=${encodeURIComponent(wallet.address)}&network=${encodeURIComponent(network)}`, { signal: AbortSignal.timeout(17000) });
          if (!response.ok) throw new Error('Server scan failed');
          data = await response.json();
          if (!Array.isArray(data.assets)) throw new Error('Invalid response');
        } catch (_) {
          // The preview server may not have internet access. Try from the user's browser.
          data = await scanDirect(wallet.address, network);
        }
        if (version === scanVersion) results[resultKey] = { status: 'success', assets: data.assets };
      } catch (_) { if (version === scanVersion) results[resultKey] = { status: 'error' }; }
      if (version === scanVersion) render();
    })());
  }
  loading = tasks.length > 0; render();
  await Promise.all(tasks);
  if (version === scanVersion) { loading = false; render(); }
}
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => { $('#form-error').textContent = ''; form.reset(); dialog.showModal(); }));
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  const address = $('#wallet-address').value.trim();
  const name = $('#wallet-name').value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) { $('#form-error').textContent = 'Please enter a valid 0x address with 40 hexadecimal characters.'; return; }
  if (wallets.some(wallet => wallet.address.toLowerCase() === address.toLowerCase())) { $('#form-error').textContent = 'This wallet has already been added.'; return; }
  wallets.push({ address, name }); persist(); dialog.close(); scan();
});
$('#wallet-list').addEventListener('click', event => {
  const button = event.target.closest('[data-address]');
  if (!button) return;
  wallets = wallets.filter(wallet => wallet.address.toLowerCase() !== button.dataset.address.toLowerCase());
  persist(); scan();
});
$('#network-filter').addEventListener('change', render);
$('#refresh').addEventListener('click', scan);
$('#today').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
scan();
