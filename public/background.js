'use strict';
// Uploaded files are sent directly to the private EC2 worker; the browser
// never reads, parses, derives addresses from, or scans their contents.
(function () {
  const $ = id => document.getElementById(id);
  const storageKey = 'walleto.background-jobs';
  const legacyStorageKey = 'walleto.background-job';
  const pendingUploadKey = 'walleto.pending-upload';
  let jobs = []; let job = null; let timer = null; let requestVersion = 0; let uploading = false; let reconnecting = false; let generating = false;
  let pendingUpload = null; let checkingUpload = false;
  const jobSummaries = new Map(); let summaryBusy = false; let summaryLastAt = 0; let summaryTimer = null; let summaryQueued = null;
  let storageWarning = false; let refreshingBnb = false; let restoringHidden = false;
  const view = { assetOffset: 0, walletOffset: 0, network: 'all' };
  const state = { data: null, error: '', loading: false, uploadPercent: 0 };
  const validJob = item => item && typeof item.id === 'string' && /^[a-f0-9]{64}$/.test(item.id) && typeof item.token === 'string' && /^[a-f0-9]{64}$/.test(item.token);
  const normalizeJob = item => ({ id: item.id, token: item.token, ...(['generated', 'addresses'].includes(item.kind) ? { kind: item.kind } : {}) });
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) {
      const stored = JSON.parse(saved);
      if (Array.isArray(stored)) jobs = stored.filter(validJob).map(normalizeJob);
    } else {
      const legacy = JSON.parse(localStorage.getItem(legacyStorageKey) || 'null');
      if (validJob(legacy)) {
        jobs = [normalizeJob(legacy)];
        localStorage.setItem(storageKey, JSON.stringify(jobs)); localStorage.removeItem(legacyStorageKey);
      }
    }
  } catch (_) { storageWarning = true; }
  try {
    const attempt = JSON.parse(localStorage.getItem(pendingUploadKey) || 'null');
    if (attempt && typeof attempt.id === 'string' && /^[a-f0-9]{64}$/.test(attempt.id)
      && ['upload', 'addresses', 'addressKeys'].includes(attempt.kind)) pendingUpload = { id: attempt.id, kind: attempt.kind, checkedNotFound: attempt.checkedNotFound === true,
        ...(Number.isSafeInteger(attempt.size) && attempt.size >= 0 ? { size: attempt.size } : {}),
        ...(Number.isSafeInteger(attempt.lastModified) && attempt.lastModified >= 0 ? { lastModified: attempt.lastModified } : {}) };
  } catch (_) { storageWarning = true; }
  job = jobs.at(-1) || null;
  function persistJobs() {
    try { localStorage.setItem(storageKey, JSON.stringify(jobs)); localStorage.removeItem(legacyStorageKey); storageWarning = false; return true; }
    catch (_) { storageWarning = true; return false; }
  }
  function savePendingUpload(attempt) {
    pendingUpload = attempt;
    try { localStorage.setItem(pendingUploadKey, JSON.stringify(attempt)); return true; }
    catch (_) { storageWarning = true; return false; }
  }
  function clearPendingUpload() {
    pendingUpload = null;
    try { localStorage.removeItem(pendingUploadKey); } catch (_) { storageWarning = true; }
  }
  function makeUploadId() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') throw new Error('Secure upload IDs are unavailable in this browser.');
    return Array.from(window.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // Reconnection merges with both current and legacy saved links rather than
  // silently replacing other jobs in this browser. Refuse malformed storage.
  function readStoredJobs() {
    const result = []; const raw = localStorage.getItem(storageKey);
    if (raw !== null) {
      const value = JSON.parse(raw);
      if (!Array.isArray(value) || !value.every(validJob)) throw new Error('Invalid saved jobs');
      result.push(...value.map(normalizeJob));
    }
    const legacy = localStorage.getItem(legacyStorageKey);
    if (legacy !== null) {
      const value = JSON.parse(legacy);
      if (value !== null && !validJob(value)) throw new Error('Invalid legacy job');
      if (value) result.push(normalizeJob(value));
    }
    return result;
  }
  function mergedJobs(...lists) {
    const byId = new Map();
    for (const item of lists.flat()) byId.set(item.id, normalizeJob(item));
    return [...byId.values()];
  }
  const privateAccess = () => (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname))
    || (location.protocol === 'https:' && location.hostname.endsWith('.ts.net') && !location.port);
  function notify() { window.dispatchEvent(new Event('file-scan:update')); }
  function importStatus(message, error = false) {
    const el = $('import-status');
    el.textContent = message; el.hidden = false; el.classList.toggle('error', error);
  }
  function snapshot() {
    return { hasJob: Boolean(job), jobId: job?.id || null, jobs: jobs.map(item => ({ id: item.id, ...(jobSummaries.get(item.id) || {}), ...(['generated', 'addresses'].includes(item.kind) ? { kind: item.kind } : {}) })), uploading, generating, pendingUpload: pendingUpload ? { kind: pendingUpload.kind, checkedNotFound: pendingUpload.checkedNotFound === true } : null, checkingUpload, storageWarning, ...state, view: { ...view } };
  }
  async function request(suffix = '', method = 'GET') {
    if (!job || !privateAccess()) throw new Error('Reconnect through the private SSH tunnel or authenticated Tailscale URL to EC2.');
    const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/background/jobs/${job.id}${suffix}`, { method, headers: { Authorization: `Bearer ${job.token}` }, signal: controller.signal });
      if (!response.ok) throw new Error('Could not load the server job. Check the SSH tunnel, worker configuration, and EC2 deployment.');
      return await response.json();
    } finally { clearTimeout(deadline); }
  }
  function summaryFrom(data) {
    return { status: data.status, kind: data.kind || 'upload', wallets: data.wallets || 0, total: data.total || 0,
      completed: data.completed || 0, incomplete: data.incomplete || 0, createdAt: data.createdAt || null,
      lines: data.lines || 0, invalid: data.invalid || 0 };
  }
  async function refreshJobSummaries(ids = jobs.slice(-20).map(item => item.id), force = false) {
    const unique = [...new Set(ids)].filter(id => jobs.some(item => item.id === id)).slice(0, 20);
    if (!unique.length || !privateAccess()) return;
    if (summaryBusy) {
      if (force) summaryQueued = { ids: [...new Set([...(summaryQueued?.ids || []), ...unique])].slice(0, 20), force: true };
      return;
    }
    if (!force && Date.now() - summaryLastAt < 8000) return;
    summaryBusy = true; summaryLastAt = Date.now(); clearTimeout(summaryTimer);
    try {
      await Promise.allSettled(unique.map(async id => {
        const link = jobs.find(item => item.id === id);
        if (!link) return;
        if (job?.id === id && state.data) { jobSummaries.set(id, summaryFrom(state.data)); return; }
        const response = await fetch(`/api/background/jobs/${id}`, { headers: { Authorization: `Bearer ${link.token}` }, cache: 'no-store', signal: AbortSignal.timeout(7000) });
        if (!response.ok) throw new Error('Scan status unavailable');
        const data = await response.json();
        if (data?.id !== id || !['importing', 'scanning', 'finished', 'failed'].includes(data.status)
          || !['upload', 'generated', 'addresses'].includes(data.kind)
          || !Number.isSafeInteger(data.wallets) || !Number.isSafeInteger(data.total)
          || !Number.isSafeInteger(data.completed) || !Number.isSafeInteger(data.incomplete)) throw new Error('Invalid scan summary');
        jobSummaries.set(id, summaryFrom(data));
      }));
    } finally {
      summaryBusy = false; notify();
      if (summaryQueued) {
        const queued = summaryQueued; summaryQueued = null;
        summaryTimer = setTimeout(() => refreshJobSummaries(queued.ids, queued.force), 0);
      } else if (unique.some(id => ['importing', 'scanning'].includes(jobSummaries.get(id)?.status))) {
        summaryTimer = setTimeout(() => refreshJobSummaries(unique, true), 10000);
      }
    }
  }
  async function checkPendingUpload() {
    if (!pendingUpload || checkingUpload) return;
    if (!privateAccess()) {
      state.error = 'Reconnect to the private EC2 URL before checking whether the upload was accepted.';
      importStatus(state.error, true); notify(); return;
    }
    const attempt = { ...pendingUpload };
    checkingUpload = true; $('check-upload').disabled = true; notify();
    try {
      const response = await fetch('/api/background/uploads/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: attempt.id }), cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('EC2 could not confirm this upload yet. Check the private connection and try again.');
      const result = await response.json();
      if (!result || typeof result.found !== 'boolean') throw new Error('EC2 returned an invalid upload-status response.');
      if (!result.found) {
        const updated = { ...attempt, checkedNotFound: true }; savePendingUpload(updated);
        state.error = 'No matching upload is recorded on EC2 yet. Re-select the same file to retry safely; the request ID prevents a duplicate if the first request arrives late.';
        importStatus(state.error, true); notify(); return;
      }
      if (result.pending) {
        savePendingUpload({ ...attempt, checkedNotFound: false });
        state.error = 'EC2 is still receiving this upload. Wait a moment and check again; do not upload it again yet.';
        importStatus(state.error, true); notify(); return;
      }
      const expectedKind = ['addresses', 'addressKeys'].includes(attempt.kind) ? 'addresses' : 'upload';
      if (!validJob(result) || result.token !== attempt.id || result.kind !== expectedKind
        || !['importing', 'scanning', 'finished', 'failed'].includes(result.status)) throw new Error('EC2 found a record but could not safely reconnect it. Keep the attempt and try again.');
      const recovered = normalizeJob(result);
      jobs = mergedJobs(jobs, [recovered]); job = recovered; requestVersion++; clearTimeout(timer);
      state.data = null; state.error = ''; state.loading = false; state.uploadPercent = 0;
      Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
      const savedLink = persistJobs(); if (savedLink) clearPendingUpload();
      importStatus(savedLink ? 'Upload found on EC2 and reconnected. No second upload was created.' : 'Upload found on EC2. Browser storage could not save the access link; the request ID was kept so you can check again.', storageWarning);
      window.dispatchEvent(new Event('file-scan:started')); notify(); await refresh();
    } catch (error) {
      if (pendingUpload?.id === attempt.id) {
        state.error = error?.message || 'Could not check upload status. Keep this attempt and retry the status check before uploading again.';
        importStatus(state.error, true); notify();
      }
    } finally {
      checkingUpload = false; $('check-upload').disabled = false; notify();
    }
  }
  function schedule(delay) { clearTimeout(timer); timer = setTimeout(refresh, delay); }
  async function refresh() {
    clearTimeout(timer);
    if (!job) { state.loading = false; notify(); return; }
    if (!privateAccess()) {
      state.error = 'Open the private EC2 dashboard through the private SSH tunnel or authenticated Tailscale URL to see server results.';
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
      jobSummaries.set(current.id, summaryFrom(data));
      notify(); refreshJobSummaries();
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
  async function stopGeneration() {
    if (!job || !state.data?.generationActive) return;
    const current = job; const button = $('stop-generation'); button.disabled = true;
    try {
      await request('/stop-generation', 'POST');
      if (current !== job) return;
      importStatus('Automatic generation stopped. EC2 will finish the already queued scans.');
      await refresh();
    } catch (_) { importStatus('Could not stop generation. Reconnect the private EC2 tunnel and try again.', true); }
    finally { button.disabled = false; }
  }
  async function resumeGeneration() {
    if (!job || state.data?.kind !== 'generated' || state.data.status !== 'finished' || state.data.generationActive) return;
    const current = job; const button = $('resume-generation'); button.disabled = true;
    try {
      await request('/resume-generation', 'POST');
      if (current !== job) return;
      importStatus('Automatic generation resumed in the existing server job.');
      await refresh();
    } catch (_) { importStatus('Could not resume this generated job. Check its status and reconnect the private EC2 tunnel.', true); }
    finally { button.disabled = false; }
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
    if (!confirm(`Recheck BNB, BUSD and USDT for all ${state.data.wallets.toLocaleString()} wallets on EC2? This can take time. Previous balances remain visible while updating.`)) return;
    refreshingBnb = true;
    try { await request('/refresh-bnb', 'POST'); importStatus('Rechecking BNB, BUSD and USDT on EC2. The server continues if this laptop is off.'); await refresh(); }
    catch (_) { importStatus('Could not start the BNB, BUSD and USDT refresh. Reconnect the SSH tunnel and try again.', true); }
    finally { refreshingBnb = false; }
  }
  async function remove() {
    if (!job || !state.data || !['finished', 'failed'].includes(state.data.status)) return false;
    if (!confirm('Delete this server job, its results, and retained recovery phrases? Snapshots, backups, and database remnants may still contain recoverable copies; this is not guaranteed secure erasure.')) return false;
    try {
      const removed = job;
      await request('', 'DELETE');
      jobs = jobs.filter(item => item.id !== removed.id); jobSummaries.delete(removed.id); persistJobs();
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
  async function reconnectFileJob() {
    if (uploading || reconnecting || generating) return importStatus('Wait for the current upload, generation or reconnection to finish.', true);
    if (!privateAccess()) return importStatus('Open the private EC2 dashboard through the private SSH tunnel or authenticated Tailscale URL.', true);
    const field = $('file-recovery-code'); const code = field.value.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(code)) return importStatus('Enter the one-time code generated on EC2.', true);
    let before;
    try {
      localStorage.setItem(`${storageKey}.test`, '1'); localStorage.removeItem(`${storageKey}.test`);
      before = readStoredJobs();
    } catch (_) { return importStatus('Browser storage is unavailable or its saved links are invalid. No recovery code was used.', true); }
    if (!confirm('Reconnect this EC2 server job? This replaces older browser access links for that job. The scan and saved results are not deleted.')) return;
    field.value = ''; reconnecting = true; $('file-reconnect').disabled = true;
    try {
      const response = await fetch('/api/background/reconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store' });
      if (!response.ok) throw new Error('Recovery failed');
      const result = await response.json();
      if (!validJob(result)) throw new Error('Invalid recovery response');
      const recovered = normalizeJob(result);
      let stored = before; let canPersist = true;
      try { stored = readStoredJobs(); } catch (_) { canPersist = false; }
      jobs = mergedJobs(jobs, before, stored, [recovered]);
      job = recovered; requestVersion++; clearTimeout(timer);
      state.data = null; state.error = ''; state.loading = false; state.uploadPercent = 0;
      Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
      if (canPersist) persistJobs(); else storageWarning = true;
      const warning = storageWarning ? ' Browser storage failed; keep this page open or generate another recovery code.' : '';
      importStatus(`Existing EC2 job reconnected.${warning}`, storageWarning);
      window.dispatchEvent(new Event('file-scan:started')); notify(); await refresh();
    } catch (_) {
      importStatus('Could not reconnect. Check the private tunnel and generate a new code if the previous one expired or was used.', true);
    } finally { reconnecting = false; $('file-reconnect').disabled = false; }
  }
  async function generatePhrase() {
    if (uploading || reconnecting || generating) return importStatus('Wait for the current upload, generation or reconnection to finish.', true);
    if (!privateAccess()) return importStatus('Phrase generation requires the private SSH tunnel or authenticated Tailscale URL to EC2. Nothing was generated or scanned.', true);
    let before;
    try {
      localStorage.setItem(`${storageKey}.test`, '1'); localStorage.removeItem(`${storageKey}.test`);
      before = readStoredJobs();
    } catch (_) { return importStatus('Browser storage is unavailable or its saved links are invalid. No phrase was generated.', true); }
    generating = true; $('generate-phrase').disabled = true;
    importStatus('Starting automatic generation and scanning on EC2.'); notify();
    try {
      const response = await fetch('/api/background/jobs/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
      if (response.status === 409) return importStatus('An automatic generator is already running. Select its job, or reconnect it with an EC2 recovery code, to stop it.', true);
      if (response.status !== 202) throw new Error('Generation not confirmed');
      const result = await response.json();
      if (!validJob(result) || result.kind !== 'generated') throw new Error('Invalid generation response');
      const generated = normalizeJob(result);
      let stored = before; let canPersist = true;
      try { stored = readStoredJobs(); } catch (_) { canPersist = false; }
      jobs = mergedJobs(jobs, before, stored, [generated]);
      job = jobs.find(item => item.id === generated.id); requestVersion++; clearTimeout(timer);
      state.data = null; state.error = ''; state.loading = false; state.uploadPercent = 0;
      Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
      if (canPersist) persistJobs(); else storageWarning = true;
      const warning = storageWarning ? ' Browser storage failed; keep this page open or recover the server job later.' : '';
      importStatus(`Automatic generation started. EC2 continues generating and scanning if this laptop is off.${warning}`, storageWarning);
      window.dispatchEvent(new Event('file-scan:started')); notify(); await refresh();
    } catch (_) {
      importStatus('Generation status is unknown. EC2 may have started a job; check the server before retrying.', true);
    } finally { generating = false; $('generate-phrase').disabled = false; notify(); }
  }
  $('generate-phrase').addEventListener('click', generatePhrase);
  $('file-reconnect').addEventListener('click', reconnectFileJob);
  $('check-upload').addEventListener('click', checkPendingUpload);
  $('file-recovery-code').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); reconnectFileJob(); }
  });
  function uploadFile(file, kind) {
    if (!pendingUpload) {
      try {
        if (!savePendingUpload({ id: makeUploadId(), kind, checkedNotFound: false, size: file.size, lastModified: file.lastModified })) return importStatus('Browser storage could not save the upload-status ID, so the file was not sent.', true);
      } catch (error) { return importStatus(error.message || 'Could not create a safe upload request ID.', true); }
    }
    if (pendingUpload.kind !== kind) return importStatus('A different file type has an unresolved upload. Check its EC2 status first.', true);
    uploading = true; state.uploadPercent = 0; state.error = ''; state.data = null; state.loading = false;
    job = null; requestVersion++; clearTimeout(timer);
    Object.assign(view, { assetOffset: 0, walletOffset: 0, network: 'all' });
    importStatus('Uploading to EC2 — keep the laptop on until the upload is confirmed.');
    window.dispatchEvent(new Event('file-scan:started')); notify();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', kind === 'addresses' ? '/api/background/jobs/addresses' : kind === 'addressKeys' ? '/api/background/jobs/address-keys' : '/api/background/jobs');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Walleto-Upload-ID', pendingUpload.id);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) state.uploadPercent = Math.max(0, Math.min(100, Math.floor(event.loaded * 100 / event.total)));
      notify();
    };
    const failed = () => {
      uploading = false; state.error = 'Upload status is unknown. Check EC2 for this upload before retrying.';
      importStatus(state.error, true); notify(); checkPendingUpload();
    };
    xhr.onerror = failed; xhr.onabort = failed;
    xhr.onload = () => {
      uploading = false;
      let result;
      try { result = JSON.parse(xhr.responseText); } catch (_) { return failed(); }
      if (xhr.status === 202 && result?.pending === true) {
        savePendingUpload({ ...pendingUpload, checkedNotFound: false });
        state.error = 'EC2 is still receiving this upload. Check again in a moment; do not send it again yet.';
        importStatus(state.error, true); notify(); return;
      }
      const addressJob = kind === 'addresses' || kind === 'addressKeys';
      if (xhr.status !== 202 || !validJob(result) || (addressJob && result.kind !== 'addresses')) {
        if (xhr.status === 413) {
          clearPendingUpload();
          state.error = kind === 'addresses' ? 'CSV exceeds the 256 MiB upload limit.' : kind === 'addressKeys' ? 'Address/private-key file exceeds the 256 MiB upload limit.' : 'Upload exceeds the server limit.';
          importStatus(state.error, true); notify(); return;
        }
        if ([400, 403].includes(xhr.status)) clearPendingUpload();
        state.error = xhr.status === 409 && result?.error ? result.error : 'Upload was not confirmed. Check EC2 for this upload before retrying.';
        importStatus(state.error, true); notify();
        if (![400, 403, 409].includes(xhr.status)) checkPendingUpload();
        return;
      }
      job = normalizeJob(result);
      jobs = mergedJobs(jobs, [job]); const savedLink = persistJobs(); if (savedLink) clearPendingUpload();
      const warning = storageWarning ? ' Browser storage failed; keep this page open or check upload status again before leaving.' : '';
      importStatus(`Upload confirmed. EC2 continues processing even if this laptop is off.${warning}`, storageWarning);
      refresh();
    };
    try { xhr.send(file); } catch (_) { failed(); }
  }
  function selectUpload(fieldId, kind) {
    const field = $(fieldId); const file = field.files[0];
    // Do not read or display a filename: it might itself contain sensitive information.
    field.value = '';
    if (!file) return;
    if (uploading || reconnecting || generating) return importStatus('An upload, generation or reconnection is already in progress.', true);
    const addresses = kind === 'addresses' || kind === 'addressKeys';
    const addressKeys = kind === 'addressKeys';
    if (addressKeys ? !/\.(?:txt|tsv)$/i.test(file.name) : addresses ? !/\.csv$/i.test(file.name) : !/\.txt$/i.test(file.name)) return importStatus(addressKeys ? 'Choose a UTF-8 .txt or .tsv file.' : addresses ? 'Choose a UTF-8 .csv file.' : 'Choose a UTF-8 .txt file.', true);
    if (addresses && file.size > 256 * 1024 * 1024) return importStatus(addressKeys ? 'Address/private-key file exceeds the 256 MiB upload limit.' : 'CSV exceeds the 256 MiB upload limit.', true);
    if (!privateAccess()) return importStatus('File import requires the private SSH tunnel or authenticated Tailscale URL to EC2. The file was not processed or uploaded in this browser.', true);
    try { localStorage.setItem(`${storageKey}.test`, '1'); localStorage.removeItem(`${storageKey}.test`); }
    catch (_) { return importStatus('Browser storage is unavailable; the server job could not be safely linked for reconnection.', true); }
    if (pendingUpload) {
      if (pendingUpload.kind !== kind) return importStatus('A different file type has an unresolved upload. Check its EC2 status first.', true);
      if (pendingUpload.size !== undefined && (pendingUpload.size !== file.size || pendingUpload.lastModified !== file.lastModified)) return importStatus('Choose the same file as the unresolved upload attempt; this selection was not sent.', true);
      if (!pendingUpload.checkedNotFound) {
        importStatus('Checking EC2 for the earlier upload first. The selected file was not sent.', true);
        checkPendingUpload(); return;
      }
    }
    const confirmation = pendingUpload?.checkedNotFound
      ? `EC2 reported no matching job. Retry this same file using the same safe request ID? ${addressKeys ? 'Raw private keys will be sent over the private tunnel and temporarily stored encrypted on EC2.' : addresses ? 'This public-address file will be sent to EC2.' : 'This phrase file will be sent to EC2 and temporarily stored encrypted.'} Do not continue if this is not the original file.`
      : addressKeys
      ? 'Upload this address/private-key file to EC2? Raw private keys will be sent over the private tunnel and temporarily stored encrypted on EC2 while the worker verifies each pair and derives public addresses. The encryption key is on the same volume, so an administrator, compromise, snapshot or backup could expose them; secure erasure is not guaranteed. Only verified public addresses and scan results remain in the job. Continue only if you accept sending raw private keys to EC2; do not use keys protecting valuable funds.'
      : addresses
        ? 'Upload this public-address CSV to EC2? The entire file is sent to the server and temporarily stored encrypted, with its key on the same EC2 volume. Include public addresses only: remove any recovery phrases or private keys first. Keep this laptop on until the upload is confirmed. Continue only through a private SSH or authenticated Tailscale connection?'
        : 'Upload this .txt file containing recovery phrases to EC2? The server processes it and temporarily stores encrypted copies of valid phrases; the encryption key is on the same EC2 volume. Server administrators, a compromise, snapshots or backups may expose them, and deletion is not guaranteed secure erasure. Do not use phrases protecting valuable funds. Keep this laptop on until the upload is confirmed. Continue only through a private SSH or authenticated Tailscale connection?';
    if (!confirm(confirmation)) return importStatus('Upload cancelled; no file was sent.');
    uploadFile(file, kind);
  }
  $('seed-file').addEventListener('change', () => selectUpload('seed-file', 'upload'));
  $('address-file').addEventListener('change', () => selectUpload('address-file', 'addresses'));
  $('address-key-file').addEventListener('change', () => selectUpload('address-key-file', 'addressKeys'));
  window.addEventListener('beforeunload', event => { if (uploading || generating) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { $('file-recovery-code').value = ''; requestVersion++; clearTimeout(timer); clearTimeout(summaryTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted && job) refresh(); });
  window.fileScan = { snapshot, setView, select, refresh, refreshJobSummaries, restoreHidden, refreshBnb, retry, stopGeneration, resumeGeneration, remove, phrase, checkPendingUpload };
  if (job) refresh();
  if (pendingUpload) setTimeout(checkPendingUpload, 500);
})();
