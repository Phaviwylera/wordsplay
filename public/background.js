'use strict';
// Uploaded files are sent directly to the private EC2 worker; the browser
// never reads, parses, derives addresses from, or scans their contents.
(function () {
  const $ = id => document.getElementById(id);
  const storageKey = 'walleto.background-jobs';
  const legacyStorageKey = 'walleto.background-job';
  let jobs = []; let job = null; let timer = null; let requestVersion = 0; let uploading = false;
  let storageWarning = false; let refreshingBnb = false; let restoringHidden = false;
  const view = { assetOffset: 0, walletOffset: 0, network: 'all' };
  const state = { data: null, error: '', loading: false, uploadPercent: 0 };
  const validJob = item => item && /^[a-f0-9]{64}$/.test(item.id || '') && /^[a-f0-9]{64}$/.test(item.token || '');
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) {
      const stored = JSON.parse(saved);
      if (Array.isArray(stored)) jobs = stored.filter(validJob).map(item => ({ id: item.id, token: item.token }));
    } else {
      const legacy = JSON.parse(localStorage.getItem(legacyStorageKey) || 'null');
      if (validJob(legacy)) {
        jobs = [{ id: legacy.id, token: legacy.token }];
        localStorage.setItem(storageKey, JSON.stringify(jobs)); localStorage.removeItem(legacyStorageKey);
      }
    }
  } catch (_) { storageWarning = true; }
  job = jobs.at(-1) || null;
  function persistJobs() {
    try { localStorage.setItem(storageKey, JSON.stringify(jobs)); localStorage.removeItem(legacyStorageKey); storageWarning = false; }
    catch (_) { storageWarning = true; }
  }
  const privateAccess = () => location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
  function notify() { window.dispatchEvent(new Event('file-scan:update')); }
  function importStatus(message, error = false) {
    const el = $('import-status');
    el.textContent = message; el.hidden = false; el.classList.toggle('error', error);
  }
  function snapshot() {
    return { hasJob: Boolean(job), jobId: job?.id || null, jobs: jobs.map(item => ({ id: item.id })), uploading, storageWarning, ...state, view: { ...view } };
  }
  async function request(suffix = '', method = 'GET') {
    if (!job || !privateAccess()) throw new Error('Reconnect to the EC2 app through the private SSH tunnel.');
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/background/jobs/${job.id}${suffix}`, { method, headers: { Authorization: `Bearer ${job.token}` }, signal: controller.signal });
      if (!response.ok) throw new Error('Could not load the server job. Check the SSH tunnel, worker configuration, and EC2 deployment.');
      return await response.json();
    } finally { clearTimeout(deadline); }
  }
  function schedule(delay) { clearTimeout(timer); timer = setTimeout(refresh, delay); }
  async function refresh() {
    clearTimeout(timer);
    if (!job) { state.loading = false; notify(); return; }
    if (!privateAccess()) {
      state.error = 'Reconnect to the EC2 app through the private SSH tunnel to see file results.';
      state.loading = false; notify(); return;
    }
    const version = ++requestVersion; const current = job;
    const params = new URLSearchParams({ assetOffset: String(view.assetOffset), walletOffset: String(view.walletOffset), network: view.network });
    state.loading = true; notify();
    try {
      const data = await request(`/dashboard?${params}`);
      if (version !== requestVersion || current !== job) return;
      const counts = ['assetCount', 'filteredAssetCount', 'wallets', 'total', 'completed', 'incomplete', 'invalid', 'assetOffset', 'walletOffset'];
      if (!data || data.id !== current.id || !Array.isArray(data.assets) || !Array.isArray(data.walletPage)
        || counts.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)
        || data.completed > data.total || data.incomplete > data.completed
        || !(data.knownValue === null || Number.isFinite(data.knownValue))
        || ((data.visibleWallets !== undefined || data.hiddenWallets !== undefined) && (!Number.isSafeInteger(data.visibleWallets) || data.visibleWallets < 0 || !Number.isSafeInteger(data.hiddenWallets) || data.hiddenWallets < 0 || data.visibleWallets + data.hiddenWallets !== data.wallets))
        || data.assetOffset !== view.assetOffset || data.walletOffset !== view.walletOffset || data.network !== view.network
        || !['importing', 'scanning', 'finished', 'failed'].includes(data.status)) throw new Error('Invalid dashboard response');
      state.data = data; state.error = ''; state.loading = false;
      notify();
      // Small jobs finish quickly; show their successful results without a
      // four-second wait. Keep larger jobs gentler on EC2 and SQLite.
      if (['importing', 'scanning'].includes(data.status)) schedule(data.total <= 100 ? 1000 : 4000);
    } catch (_) {
      if (version !== requestVersion || current !== job) return;
      state.loading = false;
      state.error = 'Could not load server results. Reconnect the SSH tunnel and ensure the EC2 worker is enabled and updated.';
      notify(); schedule(10000);
    }
  }
  function setView(next) {
    const updated = {
      assetOffset: Number.isSafeInteger(next.assetOffset) && next.assetOffset >= 0 ? next.assetOffset : view.assetOffset,
      walletOffset: Number.isSafeInteger(next.walletOffset) && next.walletOffset >= 0 ? next.walletOffset : view.walletOffset,
      network: typeof next.network === 'string' ? next.network : view.network,
    };
    if (updated.assetOffset === view.assetOffset && updated.walletOffset === view.walletOffset && updated.network === view.network) return;
    Object.assign(view, updated);
    if (job) refresh(); else notify();
  }
  function select(id) {
    if (uploading) return;
    const selected = jobs.find(item => item.id === id);
    if (!selected || selected === job) return;
    requestVersion++; clearTimeout(timer); job = selected;
    state.data = null; state.error = ''; state.loading = false;
    Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
    refresh();
  }
  async function retry() {
    if (!job || !state.data || state.data.status !== 'finished' || !state.data.incomplete) return;
    try { await request('/retry', 'POST'); importStatus('Retrying incomplete checks on the server.'); refresh(); }
    catch (_) { importStatus('Could not retry the server checks. Reconnect the SSH tunnel and try again.', true); }
  }
  async function restoreHidden() {
    if (restoringHidden || !job || !state.data?.hiddenWallets) return;
    restoringHidden = true; const current = job;
    try {
      const result = await request('/restore-hidden', 'POST');
      if (current !== job) return;
      if (!Number.isSafeInteger(result.restored) || result.restored < 0) throw new Error('Invalid restore response');
      importStatus(`Restored ${result.restored.toLocaleString()} hidden wallet${result.restored === 1 ? '' : 's'} to this file view.`);
      await refresh();
    } catch (_) {
      if (current === job) {
        state.error = 'Could not restore hidden wallets. Reconnect the private EC2 tunnel and try again.';
        importStatus(state.error, true); notify();
      }
    } finally { restoringHidden = false; }
  }
  async function refreshBnb() {
    if (refreshingBnb || !job || state.data?.status !== 'finished' || !state.data.wallets) return;
    if (!confirm(`Recheck BNB and BUSD for all ${state.data.wallets.toLocaleString()} wallets on EC2? This can take time. Previous balances remain visible while updating.`)) return;
    refreshingBnb = true;
    try { await request('/refresh-bnb', 'POST'); importStatus('Rechecking BNB and BUSD on EC2. The server continues if this laptop is off.'); await refresh(); }
    catch (_) { importStatus('Could not start the BNB and BUSD refresh. Reconnect the SSH tunnel and try again.', true); }
    finally { refreshingBnb = false; }
  }
  async function remove() {
    if (!job || !state.data || !['finished', 'failed'].includes(state.data.status)) return false;
    if (!confirm('Delete this server job, its results, and retained recovery phrases? Snapshots, backups, and database remnants may still contain recoverable copies; this is not guaranteed secure erasure.')) return false;
    try {
      const removed = job;
      await request('', 'DELETE');
      jobs = jobs.filter(item => item.id !== removed.id); persistJobs();
      const wasCurrent = removed === job;
      if (wasCurrent) {
        job = jobs.at(-1) || null; requestVersion++; clearTimeout(timer);
        state.data = null; state.error = ''; state.loading = false;
        Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
      }
      importStatus(storageWarning ? 'Server job removed, but browser storage could not update the job list.' : 'Server results and retained phrases removed from application records.', storageWarning);
      notify(); if (wasCurrent && job) refresh(); return wasCurrent;
    } catch (_) { importStatus('Could not delete the server job. Reconnect the SSH tunnel and try again.', true); return false; }
  }
  async function phrase(address, expectedJobId) {
    if (!job || job.id !== expectedJobId || !privateAccess()) throw new Error('The server job is no longer available.');
    const current = job;
    const result = await request(`/phrase?address=${encodeURIComponent(address)}`);
    if (current !== job || job.id !== expectedJobId) throw new Error('The server job changed.');
    if (typeof result.phrase !== 'string' || result.phrase.length > 256 || ![12, 15, 18, 21, 24].includes(result.phrase.trim().split(/\s+/).length)) throw new Error('The server could not verify this recovery phrase.');
    return result.phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  $('seed-file').addEventListener('change', () => {
    const field = $('seed-file'); const file = field.files[0];
    // Do not display a file name: it might itself contain sensitive information.
    field.value = '';
    if (!file) return;
    if (uploading) return importStatus('A file upload is already in progress.', true);
    if (!/\.txt$/i.test(file.name)) return importStatus('Choose a UTF-8 .txt file.', true);
    if (!privateAccess()) return importStatus('File import requires the private SSH tunnel to EC2. The file was not processed or uploaded in this browser.', true);
    try { localStorage.setItem(`${storageKey}.test`, '1'); localStorage.removeItem(`${storageKey}.test`); }
    catch (_) { return importStatus('Browser storage is unavailable; the server job could not be safely linked for reconnection.', true); }
    if (!confirm('Upload this .txt file containing recovery phrases to EC2? The server processes it and temporarily stores encrypted copies of valid phrases; the encryption key is on the same EC2 volume. Server administrators, a compromise, snapshots or backups may expose them, and deletion is not guaranteed secure erasure. Do not use phrases protecting valuable funds. Keep this laptop on until the upload is confirmed. Continue only through a private SSH tunnel?')) {
      return importStatus('Upload cancelled; no file was sent.');
    }
    uploading = true; state.uploadPercent = 0; state.error = ''; state.data = null; state.loading = false;
    job = null; requestVersion++; clearTimeout(timer);
    Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
    importStatus('Uploading to EC2 — keep the laptop on until the upload is confirmed.');
    window.dispatchEvent(new Event('file-scan:started')); notify();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/background/jobs');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) state.uploadPercent = Math.max(0, Math.min(100, Math.floor(event.loaded * 100 / event.total)));
      notify();
    };
    const failed = () => {
      uploading = false; state.error = 'Upload status is unknown. EC2 may have accepted it; check the server before retrying.';
      importStatus(state.error, true); notify();
    };
    xhr.onerror = failed; xhr.onabort = failed;
    xhr.onload = () => {
      uploading = false;
      let result;
      try { result = JSON.parse(xhr.responseText); } catch (_) { return failed(); }
      if (xhr.status !== 202 || !/^[a-f0-9]{64}$/.test(result.id || '') || !/^[a-f0-9]{64}$/.test(result.token || '')) {
        state.error = 'Upload was not confirmed. Check the private tunnel and EC2 worker before retrying.';
        importStatus(state.error, true); notify(); return;
      }
      job = { id: result.id, token: result.token };
      jobs.push(job); persistJobs();
      const warning = storageWarning ? ' Browser storage failed; keep this page open or access to this job may be lost.' : '';
      importStatus(`Upload confirmed. EC2 continues processing even if this laptop is off.${warning}`, storageWarning);
      refresh();
    };
    try { xhr.send(file); } catch (_) { failed(); }
  });
  window.addEventListener('beforeunload', event => { if (uploading) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { requestVersion++; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted && job) refresh(); });
  window.fileScan = { snapshot, setView, select, refresh, restoreHidden, refreshBnb, retry, remove, phrase };
  if (job) refresh();
})();
