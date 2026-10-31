'use strict';
// This feature is intentionally separate from the existing browser scan.
(function () {
  const $ = id => document.getElementById(id);
  const key = 'walleto.background-job';
  const panel = $('background-panel');
  const PAGE_SIZE = 100;
  const MATCH_PAGE_SIZE = 20;
  let job = null; let offset = 0; let matchOffset = 0; let busy = false; let timer; let storageWarning = false;
  const revealedPhrases = new Map();
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
  const number = value => Number(value || 0).toLocaleString('en-US');
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

  function renderMatches(data, status, incomplete) {
    const container = $('background-matches');
    container.replaceChildren();
    $('background-match-count').textContent = number(data.total);
    $('background-match-note').textContent = !data.enabled
      ? 'This job was uploaded before phrase matching was enabled, so EC2 has no saved phrases for it. Let it finish if it is still scanning; then delete this job in the panel and upload the .txt file again with the current app to link phrases to addresses.'
      : data.retained
        ? (['importing', 'scanning'].includes(status) || incomplete ? 'EC2 temporarily retains encrypted copies of valid phrases while scanning, and keeps them if checks are incomplete so retries can still find matches. After all checks complete, unmatched phrases are removed from the job records. Phrases are sent to this browser only when you choose Reveal.' : 'EC2 keeps encrypted phrases only for wallets with detected positive balances. Phrases are sent to this browser only when you choose Reveal.')
        : 'No recovery phrase is currently retained for a wallet with a detected positive balance. Incomplete checks are not zero balances.';
    if (!data.retained || !data.matches.length) {
      const empty = document.createElement('p');
      empty.className = 'background-match-empty';
      if (!data.enabled) empty.textContent = 'This older job has no phrase-to-address mapping. Once it finishes, delete it from this panel and upload the file again with the current app to create one.';
      else if (!data.retained && status === 'finished' && !incomplete) empty.textContent = 'No positive balances were detected, so no recovery phrases were retained.';
      else if (!data.retained) empty.textContent = 'No retained phrase matches are available for this job.';
      else if (status === 'finished' && incomplete) empty.textContent = 'No positive balance detected yet. Some checks are incomplete; that does not mean those wallets are empty.';
      else if (status === 'finished') empty.textContent = 'No positive balances were detected in the checked assets. Scan coverage limitations still apply.';
      else empty.textContent = 'No positive balance detected yet. EC2 is still scanning.';
      container.appendChild(empty);
    }
    for (const match of data.matches || []) {
      const card = document.createElement('article');
      card.className = 'background-match-card';
      const title = document.createElement('div');
      title.className = 'background-match-address';
      const addressLabel = document.createElement('span');
      addressLabel.textContent = 'Wallet address';
      const address = document.createElement('code');
      address.textContent = match.address;
      title.append(addressLabel, address);
      card.appendChild(title);

      const balances = document.createElement('div');
      balances.className = 'background-match-balances';
      for (const check of match.checks || []) {
        const line = document.createElement('p');
        const network = document.createElement('strong');
        network.textContent = check.network;
        const assets = (check.assets || []).map(formatAsset).filter(Boolean).join(', ');
        const amount = document.createElement('span');
        amount.textContent = assets || 'Positive balance detected';
        line.append(network, amount);
        if (check.status === 'partial') {
          const status = document.createElement('small');
          status.textContent = 'Partial scan';
          line.appendChild(status);
        }
        balances.appendChild(line);
      }
      card.appendChild(balances);

      const phraseBlock = document.createElement('div');
      phraseBlock.className = 'background-match-phrase-block';
      const phraseLabel = document.createElement('span');
      phraseLabel.textContent = 'Recovery phrase';
      const phrase = document.createElement('code');
      phrase.className = 'background-match-phrase';
      phrase.setAttribute('aria-live', 'polite');
      const showButton = document.createElement('button');
      showButton.type = 'button';
      showButton.className = 'background-reveal-button';
      const drawPhraseState = () => {
        const visible = revealedPhrases.has(match.address);
        phrase.textContent = visible ? revealedPhrases.get(match.address) : 'Hidden — reveal only in a private place';
        showButton.textContent = visible ? 'Hide phrase' : 'Reveal phrase';
      };
      drawPhraseState();
      showButton.addEventListener('click', async () => {
        if (revealedPhrases.has(match.address)) {
          revealedPhrases.delete(match.address);
          drawPhraseState();
          return;
        }
        showButton.disabled = true;
        phrase.textContent = 'Loading phrase…';
        try {
          const response = await request(`/phrase?address=${encodeURIComponent(match.address)}`);
          if (typeof response.phrase !== 'string' || ![12, 15, 18, 21, 24].includes(response.phrase.trim().split(/\s+/).length)) throw new Error('The saved phrase could not be verified.');
          revealedPhrases.set(match.address, response.phrase);
          drawPhraseState();
        } catch (error) { phrase.textContent = error.message; }
        finally { showButton.disabled = false; }
      });
      phraseBlock.append(phraseLabel, phrase, showButton);
      card.appendChild(phraseBlock);
      container.appendChild(card);
    }
    const pager = $('background-match-pager');
    pager.hidden = data.total <= MATCH_PAGE_SIZE;
    $('background-match-prev').disabled = matchOffset === 0;
    $('background-match-next').disabled = matchOffset + MATCH_PAGE_SIZE >= data.total;
    $('background-match-page-label').textContent = data.total
      ? `${number(matchOffset + 1)}–${number(Math.min(matchOffset + MATCH_PAGE_SIZE, data.total))} of ${number(data.total)}`
      : '0 matches';
  }

  async function refresh() {
    if (!job || !privateAccess()) return;
    try {
      const data = await request(`/results?offset=${offset}`);
      const percent = data.total ? Math.floor(data.completed * 100 / data.total) : 0;
      const message = { importing: 'Processing the uploaded file on EC2…', scanning: 'Scanning on EC2…', finished: 'Overnight scan finished', failed: 'Import failed' }[data.status] || 'Preparing…';
      show(message);
      $('background-percent').textContent = `${percent}%`;
      $('background-progress').value = percent;
      $('background-detail').textContent = `${storageWarning ? 'Browser storage failed: keep this page open or access to this job may be lost. ' : ''}${['importing', 'scanning'].includes(data.status) ? 'Upload confirmed; EC2 continues while your laptop is off. ' : ''}${number(data.wallets)} addresses · ${number(data.lines)} lines processed · ${number(data.invalid)} invalid · ${number(data.completed)}/${number(data.total)} checks · ${number(data.incomplete)} incomplete${data.error ? ` · ${data.error}` : ''}. Results are stored on EC2. Incomplete checks are not zero balances.`;
      $('background-retry').hidden = data.status !== 'finished' || !data.incomplete;
      $('background-remove').hidden = !['finished', 'failed'].includes(data.status);
      const matchData = await request(`/matches?offset=${matchOffset}`);
      renderMatches(matchData, data.status, data.incomplete);
      const table = $('background-results'); table.replaceChildren();
      for (const check of data.checks) {
        const row = document.createElement('tr');
        cell(row, check.address); cell(row, check.network);
        cell(row, check.reason ? `${check.status}: ${check.reason}` : check.status);
        cell(row, check.assets.map(formatAsset).filter(Boolean).join(', ') || '—');
        table.appendChild(row);
      }
      $('background-pager').hidden = data.total <= PAGE_SIZE;
      $('background-prev').disabled = offset === 0;
      $('background-next').disabled = offset + PAGE_SIZE >= data.total;
      $('background-page-label').textContent = `${number(Math.min(offset + 1, data.total))}–${number(Math.min(offset + PAGE_SIZE, data.total))} of ${number(data.total)}`;
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
    if (!confirm('Send this .txt file to EC2 for overnight processing? It contains recovery phrases. EC2 temporarily stores encrypted copies for all valid phrases and, after scanning, retains phrases only for wallets with detected positive balances so you can match each phrase to its address. The encryption key is stored on the same EC2 volume; administrators, a compromised server, snapshots and backups may expose phrases. Deleting a job is not guaranteed secure erasure. This unaudited app is not suitable for valuable funds. Use only a private SSH tunnel.')) return;
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
        offset = 0; matchOffset = 0; revealedPhrases.clear(); show('Upload confirmed. EC2 is processing the file; you may turn off the laptop.'); refresh();
      } catch (_) { show('Upload response was invalid. Check EC2 before retrying.'); }
    };
    xhr.send(file);
  });
  $('background-prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); refresh(); });
  $('background-next').addEventListener('click', () => { offset += PAGE_SIZE; refresh(); });
  $('background-match-prev').addEventListener('click', () => { matchOffset = Math.max(0, matchOffset - MATCH_PAGE_SIZE); refresh(); });
  $('background-match-next').addEventListener('click', () => { matchOffset += MATCH_PAGE_SIZE; refresh(); });
  $('background-retry').addEventListener('click', async () => { try { await request('/retry', 'POST'); refresh(); } catch (error) { show(error.message); } });
  $('background-remove').addEventListener('click', async () => {
    if (!confirm('Delete this job, its saved scan results, and retained phrases from EC2 application records? Snapshots, backups and SQLite remnants may still contain recoverable copies; this is not guaranteed secure erasure.')) return;
    try { await request('', 'DELETE'); localStorage.removeItem(key); job = null; revealedPhrases.clear(); clearTimeout(timer); panel.hidden = true; }
    catch (error) { show(error.message); }
  });
  if (job) {
    if (privateAccess()) refresh();
    else show('Reconnect through the SSH tunnel to see the EC2 background job.');
  }
})();
