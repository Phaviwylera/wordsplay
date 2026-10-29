import { Wallet, JsonRpcProvider, getAddress, parseEther, formatEther, isAddress } from 'ethers';

const CHAINS = {
  ethereum: { name: 'Ethereum', chainId: 1n, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://eth.blockscout.com' },
  base: { name: 'Base', chainId: 8453n, rpc: 'https://base-rpc.publicnode.com', explorer: 'https://base.blockscout.com' },
  arbitrum: { name: 'Arbitrum', chainId: 42161n, rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbitrum.blockscout.com' },
  optimism: { name: 'Optimism', chainId: 10n, rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimism.blockscout.com' },
};
const STORE = 'walleto.encrypted-wallet.v1';
const $ = s => document.querySelector(s);
let wallet = null;
let pendingWallet = null;
let mode = null;
let prepared = null;
let busy = false;
let storageAvailable = true;
function stored() { try { return localStorage.getItem(STORE); } catch (_) { storageAvailable = false; return null; } }
function message(text, error = false) { const el = $('#message'); el.textContent = text; el.hidden = !text; el.classList.toggle('error', error); }
function screen() {
  const exists = Boolean(stored());
  $('#setup').hidden = exists || Boolean(wallet);
  $('#locked').hidden = !exists || Boolean(wallet);
  $('#unlocked').hidden = !wallet;
  if (!storageAvailable) { $('#setup').hidden = true; message('Browser storage is unavailable. Enable local storage before creating or importing a wallet.', true); }
  if (wallet) $('#address').textContent = wallet.address;
}
function busyState(value) {
  busy = value;
  document.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = value; });
}
function clearSetup() {
  pendingWallet = null; mode = null;
  $('#recovery-phrase').textContent = ''; $('#phrase').value = '';
  $('#new-password').value = ''; $('#confirm-password').value = ''; $('#backed-up').checked = false;
  $('#backup').hidden = $('#import-block').hidden = $('#save-form').hidden = true;
}
function resetReview() { prepared = null; $('#review').hidden = true; $('#confirm-risk').checked = false; }
$('#create').addEventListener('click', () => {
  if (busy) return;
  try {
    clearSetup(); mode = 'create'; pendingWallet = Wallet.createRandom();
    $('#recovery-phrase').textContent = pendingWallet.mnemonic.phrase;
    $('#backup').hidden = false; $('#save-form').hidden = false; message('');
  } catch (_) { message('Could not securely generate a wallet. Use a modern browser over HTTPS.', true); }
});
$('#show-import').addEventListener('click', () => { clearSetup(); mode = 'import'; $('#import-block').hidden = false; $('#save-form').hidden = false; message(''); });
$('#save-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !mode) return;
  const password = $('#new-password').value;
  if (password.length < 12 || password !== $('#confirm-password').value) return message('Use matching passwords of at least 12 characters.', true);
  if (mode === 'create' && !$('#backed-up').checked) return message('Back up your recovery phrase before continuing.', true);
  try {
    if (mode === 'import') pendingWallet = Wallet.fromPhrase($('#phrase').value.trim().toLowerCase().replace(/\s+/g, ' '));
    if (!pendingWallet) throw new Error('Invalid wallet');
    busyState(true); message('Encrypting your wallet on this device. This can take a moment…');
    const encrypted = await pendingWallet.encrypt(password);
    // Never overwrite an existing wallet if another tab created one while we were encrypting.
    if (stored()) throw new Error('A wallet already exists on this device. Unlock it instead.');
    localStorage.setItem(STORE, encrypted);
    wallet = pendingWallet; clearSetup(); screen(); message('Wallet encrypted and saved on this device.');
  } catch (error) { message(error.message === 'A wallet already exists on this device. Unlock it instead.' ? error.message : 'Could not save wallet. Check your recovery phrase and browser storage, then try again.', true); }
  finally { busyState(false); }
});
$('#unlock-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  try {
    busyState(true); message('Unlocking your wallet on this device…');
    const json = stored(); if (!json) throw new Error('Wallet not found');
    wallet = await Wallet.fromEncryptedJson(json, $('#unlock-password').value);
    $('#unlock-password').value = ''; screen(); message('Wallet unlocked.');
  } catch (_) { message('Could not unlock wallet. Check your password and try again.', true); }
  finally { busyState(false); }
});
$('#lock-wallet').addEventListener('click', () => { wallet = null; resetReview(); $('#send-form').reset(); $('#transaction-result').hidden = true; screen(); message('Wallet locked.'); });
$('#remove-wallet').addEventListener('click', () => {
  if (busy || !confirm('Remove the encrypted wallet from this browser? You will need your recovery phrase to restore it.')) return;
  try { localStorage.removeItem(STORE); clearSetup(); screen(); message('Wallet removed from this browser.'); } catch (_) { message('Could not remove wallet from browser storage.', true); }
});
$('#copy-address').addEventListener('click', async () => { try { await navigator.clipboard.writeText(wallet.address); message('Public address copied.'); } catch (_) { message('Could not copy automatically. Select and copy the address instead.', true); } });
$('#track-address').addEventListener('click', () => {
  try {
    const saved = JSON.parse(localStorage.getItem('walleto.wallets') || '[]');
    if (!Array.isArray(saved)) throw new Error('Invalid data');
    if (!saved.some(item => typeof item.address === 'string' && item.address.toLowerCase() === wallet.address.toLowerCase())) saved.push({ address: wallet.address, name: 'My wallet' });
    localStorage.setItem('walleto.wallets', JSON.stringify(saved)); message('Address added to your portfolio dashboard.');
  } catch (_) { message('Could not add address to dashboard.', true); }
});
for (const selector of ['#send-network', '#recipient', '#send-amount']) $(selector).addEventListener('input', () => { resetReview(); $('#transaction-result').hidden = true; });
$('#send-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !wallet) return;
  resetReview(); $('#transaction-result').hidden = true;
  try {
    const chain = CHAINS[$('#send-network').value];
    if (!chain || !isAddress($('#recipient').value.trim())) throw new Error('Enter a valid recipient address and network.');
    const to = getAddress($('#recipient').value.trim());
    const value = parseEther($('#send-amount').value.trim());
    if (value <= 0n) throw new Error('Enter an amount greater than zero.');
    busyState(true); message('Checking network, balance, and network fee…');
    const provider = new JsonRpcProvider(chain.rpc);
    const network = await provider.getNetwork();
    if (network.chainId !== chain.chainId) throw new Error('The RPC returned an unexpected network.');
    const [balance, nonce, fee, gasLimit] = await Promise.all([
      provider.getBalance(wallet.address), provider.getTransactionCount(wallet.address, 'pending'), provider.getFeeData(), provider.estimateGas({ from: wallet.address, to, value }),
    ]);
    const tx = { to, value, nonce, gasLimit, chainId: chain.chainId };
    let maxFee;
    if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) { tx.type = 2; tx.maxFeePerGas = fee.maxFeePerGas; tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas; maxFee = fee.maxFeePerGas * gasLimit; }
    else if (fee.gasPrice != null) { tx.type = 0; tx.gasPrice = fee.gasPrice; maxFee = fee.gasPrice * gasLimit; }
    else throw new Error('Network fee is unavailable. Try again later.');
    if (balance < value + maxFee) throw new Error('Insufficient ETH to cover the amount and maximum network fee.');
    prepared = { tx, chain, provider };
    $('#review-network').textContent = chain.name; $('#review-from').textContent = wallet.address; $('#review-to').textContent = to;
    $('#review-amount').textContent = `${formatEther(value)} ETH`; $('#review-fee').textContent = `Up to ${formatEther(maxFee)} ETH execution gas; L2 data fees may be additional`;
    $('#review').hidden = false; message('Review the details before signing.');
  } catch (error) { const safe = ['Enter a valid recipient address and network.', 'Enter an amount greater than zero.', 'The RPC returned an unexpected network.', 'Network fee is unavailable. Try again later.', 'Insufficient ETH to cover the amount and maximum network fee.']; message(safe.includes(error.message) ? error.message : 'Could not prepare the transaction. Check the amount, network connection and RPC availability.', true); }
  finally { busyState(false); }
});
$('#cancel-send').addEventListener('click', () => { resetReview(); message('Transaction cancelled.'); });
$('#confirm-send').addEventListener('click', async () => {
  if (busy || !wallet || !prepared) return;
  if (!$('#confirm-risk').checked) return message('Please verify the recipient and network and acknowledge the transaction risk.', true);
  const { tx, provider, chain } = prepared;
  resetReview();
  try {
    busyState(true); message('Signing locally and submitting the transaction…');
    const signed = await wallet.signTransaction(tx);
    const response = await provider.broadcastTransaction(signed);
    const result = $('#transaction-result'); result.replaceChildren();
    const text = document.createElement('span'); text.textContent = 'Submitted. Check confirmation on the explorer: ';
    const link = document.createElement('a'); link.href = `${chain.explorer}/tx/${response.hash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = response.hash;
    result.append(text, link); result.hidden = false; $('#send-form').reset(); message('Transaction submitted; confirmation is not guaranteed.');
  } catch (_) { message('Submission failed or its status is unknown. Check the network explorer and your balance before trying again; the transaction may have been broadcast.', true); }
  finally { busyState(false); }
});
window.addEventListener('storage', event => { if (event.key === STORE && !wallet) { clearSetup(); screen(); } });
screen();
