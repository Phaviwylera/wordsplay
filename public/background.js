'use strict';
// This feature is intentionally separate from the existing browser scan.
(function () {
  const $ = id => document.getElementById(id);
  const key = 'walleto.background-job';
  const panel = $('background-panel');
  let job = null; let offset = 0; let busy = false; let timer; let storageWarning = false;
  try { job = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) {}
  if (!job || !/^[a-f0-9]{64}$/.test(job.id || '') || !/^[a-f0-9]{64}$/.test(job.token || '')) job = null;
  const privateAccess = () => location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
  function show(message) { panel.hidden = false; $('background-status').textContent = message; }
  function authorized(method = 'GET') { return { method, headers: { Authorization: `Bearer ${job.token}` } }; }
  async function request(suffix = '', method = 'GET') {
    const response = await fetch(`/api/background/jobs/${job.id}${suffix}`, authorized(method));
    if (!response.ok) throw new Error('Could not load the EC2 job. Check the SSH tunnel and try again.');
    return response.json();
  }
  function formatAsset(asset) {
    try {
      const decimals = Math.max(0, Math.min(100, Number(asset.decimals) || 0));
      const value = BigInt(asset.rawBalance).toString().padStart(decimals + 1, '0');
      if (BigInt(asset.rawBalance) === 0n) return null;
      const amount = decimals ? `${value.slice(0, -decimals)}.${value.slice(-decimals).replace(/0+$/, '')}`.replace(/\.$/, '') : value;
      return `${amount} ${asset.symbol || 'asset'}`;
    } catch (_) { return null; }
  }
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value; row.appendChild(td); }
  async function refresh() {
    if (!job || !privateAccess()) return;
    try {
      const data = await request(`/results?offset=${offset}`);
      const percent = data.total ? Math.floor(data.completed * 100 / data.total) : 0;
      const message = { importing: 'Processing the uploaded file on EC2…', scanning: 'Scanning on EC2…', finished: 'Overnight scan finished', failed: 'Import failed' }[data.status] || 'Preparing…';
      show(message);
      $('background-percent').textContent = `${percent}%`;
      $('background-progress').value = percent;
      $('background-detail').textContent = `${storageWarning ? 'Browser storage failed: keep this page open or access to this job may be lost. ' : ''}${['importing', 'scanning'].includes(data.status) ? 'Upload confirmed; EC2 continues while your laptop is off. ' : ''}${data.wallets} addresses · ${data.lines} lines processed · ${data.invalid} invalid · ${data.completed}/${data.total} checks · ${data.incomplete} incomplete${data.error ? ` · ${data.error}` : ''}. Results are stored on EC2. Incomplete checks are not zero balances.`;
      $('background-retry').hidden = data.status !== 'finished' || !data.incomplete;
      $('background-remove').hidden = !['finished', 'failed'].includes(data.status);
      const table = $('background-results'); table.replaceChildren();
      for (const check of data.checks) {
        const row = document.createElement('tr');
        cell(row, check.address); cell(row, check.network);
        cell(row, check.reason ? `${check.status}: ${check.reason}` : check.status);
        cell(row, check.assets.map(formatAsset).filter(Boolean).join(', ') || '—');
        table.appendChild(row);
      }
      $('background-pager').hidden = data.total <= 100;
      $('background-prev').disabled = offset === 0;
      $('background-next').disabled = offset + 100 >= data.total;
      $('background-page-label').textContent = `${offset + 1}–${Math.min(offset + 100, data.total)} of ${data.total}`;
      clearTimeout(timer);
      if (!['finished', 'failed'].includes(data.status)) timer = setTimeout(refresh, 3000);
    } catch (error) { show(error.message); clearTimeout(timer); timer = setTimeout(refresh, 10000); }
  }
  $('background-start').addEventListener('click', () => {
    if (busy) return;
    if (!privateAccess()) return show('Overnight import requires the private SSH tunnel. Do not upload seed phrases over public HTTP.');
    if (job) return show('A job is already saved in this browser. Finish and delete it before starting another.');
    const file = $('seed-file').files[0];
    if (!file || !/\.txt$/i.test(file.name)) return show('Choose a UTF-8 .txt file first.');
    try { localStorage.setItem(`${key}.test`, '1'); localStorage.removeItem(`${key}.test`); }
    catch (_) { return show('Browser storage is unavailable; the job could not be safely saved.'); }
    if (!confirm('Send this file to EC2 for overnight processing? It contains recovery phrases. EC2 temporarily stores an encrypted copy and its key; server administrators and backups may expose it. This unaudited app is not suitable for valuable funds. Use only a private SSH tunnel.')) return;
    busy = true; $('background-start').disabled = true; show('Uploading to EC2 — keep the laptop on until the upload is confirmed.');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/background/jobs');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) $('background-detail').textContent = `Upload: ${Math.floor(event.loaded * 100 / event.total)}%. Do not close this page yet.`; };
    xhr.onerror = () => { busy = false; $('background-start').disabled = false; show('Upload failed. Keep the laptop connected and try again.'); };
    xhr.onload = () => {
      busy = false; $('background-start').disabled = false;
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status !== 202 || !/^[a-f0-9]{64}$/.test(data.id || '') || !/^[a-f0-9]{64}$/.test(data.token || '')) return show(data.error || 'Upload was not accepted.');
        job = data;
        try { localStorage.setItem(key, JSON.stringify(job)); }
        catch (_) {
          storageWarning = true;
          show('Upload completed, but browser storage failed. Keep this page open; job access may be lost on reload.');
          refresh();
          return;
        }
        $('seed-file').value = ''; $('file-name').textContent = 'No file selected';
        offset = 0; show('Upload confirmed. EC2 is processing the file; you may turn off the laptop.'); refresh();
      } catch (_) { show('Upload response was invalid. Check EC2 before retrying.'); }
    };
    xhr.send(file);
  });
  $('background-prev').addEventListener('click', () => { offset = Math.max(0, offset - 100); refresh(); });
  $('background-next').addEventListener('click', () => { offset += 100; refresh(); });
  $('background-retry').addEventListener('click', async () => { try { await request('/retry', 'POST'); refresh(); } catch (error) { show(error.message); } });
  $('background-remove').addEventListener('click', async () => {
    if (!confirm('Delete this finished job and its saved scan results from EC2?')) return;
    try { await request('', 'DELETE'); localStorage.removeItem(key); job = null; clearTimeout(timer); panel.hidden = true; }
    catch (error) { show(error.message); }
  });
  if (job) {
    if (privateAccess()) refresh();
    else show('Reconnect through the SSH tunnel to see the EC2 background job.');
  }
})();
