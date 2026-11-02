import { Wallet } from 'ethers';

(() => {
  const $ = id => document.getElementById(id);
  const fileInput = $('key-file');
  const offlineNotice = $('offline-notice');
  const converter = $('converter');
  const consent = $('offline-confirm');
  const convertButton = $('convert');
  const status = $('status');
  const download = $('download-csv');
  let selectedFile = null;
  let outputUrl = null;

  const openedFromFile = location.protocol === 'file:';
  offlineNotice.hidden = openedFromFile;
  converter.hidden = !openedFromFile;

  if (!openedFromFile) {
    status.textContent = 'For safety, this converter only processes keys when opened as a downloaded local HTML file (file://). It will not read a key file from this website.';
  }

  function fieldsFor(line) {
    const delimiter = ['\t', ',', ';', '|'].find(candidate => line.includes(candidate));
    const fields = delimiter ? line.split(delimiter) : line.trim().split(/\s+/);
    return fields.map(field => {
      const value = field.trim();
      return value.length >= 2 && value[0] === '"' && value.at(-1) === '"'
        ? value.slice(1, -1).replaceAll('""', '"').trim() : value;
    });
  }

  function isHeader(fields) {
    return fields.length === 2 && /address/i.test(fields[0]) && /private[ _-]*key/i.test(fields[1]);
  }

  consent.addEventListener('change', () => {
    fileInput.disabled = !consent.checked;
    if (!consent.checked) {
      selectedFile = null;
      fileInput.value = '';
      convertButton.disabled = true;
      download.hidden = true;
      if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
      status.textContent = 'Disconnect from the internet and close Tailscale before selecting the key file.';
    } else {
      status.textContent = 'Choose the local key file. Its contents will not be displayed or uploaded.';
    }
  });

  fileInput.addEventListener('change', () => {
    selectedFile = fileInput.files?.[0] || null;
    convertButton.disabled = !selectedFile || !consent.checked;
    download.hidden = true;
    if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
    status.textContent = selectedFile ? 'Ready to verify locally. Private keys will not be shown.' : 'Choose a local address/private-key text file.';
  });

  convertButton.addEventListener('click', async () => {
    if (!openedFromFile || !consent.checked || !selectedFile) return;
    const file = selectedFile;
    selectedFile = null;
    fileInput.value = '';
    convertButton.disabled = true;
    download.hidden = true;
    if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }

    let text = '';
    let lines = [];
    const addresses = new Set();
    let malformed = 0; let mismatched = 0; let duplicates = 0; let processed = 0;
    try {
      text = await file.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      lines = text.split(/\r\n|\n|\r/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        const fields = fieldsFor(line);
        if (processed === 0 && isHeader(fields)) continue;
        processed++;
        if (fields.length !== 2 || !/^0x[0-9a-f]{40}$/i.test(fields[0]) || !/^(?:0x)?[0-9a-f]{64}$/i.test(fields[1])) {
          malformed++;
          continue;
        }
        let derived = '';
        try { derived = new Wallet(/^0x/i.test(fields[1]) ? fields[1] : `0x${fields[1]}`).address; }
        catch (_) { malformed++; continue; }
        if (derived.toLowerCase() !== fields[0].toLowerCase()) {
          mismatched++;
          continue;
        }
        if (addresses.has(derived.toLowerCase())) duplicates++;
        else addresses.add(derived.toLowerCase());
        if (processed % 250 === 0) {
          status.textContent = `Checked ${processed.toLocaleString()} rows locally…`;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      if (!addresses.size) {
        status.textContent = `No address/key pairs verified. Skipped ${malformed.toLocaleString()} malformed and ${mismatched.toLocaleString()} mismatched rows.`;
        return;
      }
      const csv = `ethereum\n${[...addresses].join('\n')}\n`;
      outputUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      download.href = outputUrl;
      download.download = 'ethereum-public-addresses.csv';
      download.hidden = false;
      status.textContent = `Verified ${addresses.size.toLocaleString()} public addresses. Skipped ${malformed.toLocaleString()} malformed rows, ${mismatched.toLocaleString()} address/key mismatches, and ${duplicates.toLocaleString()} duplicates. The CSV contains public addresses only.`;
    } catch (_) {
      status.textContent = 'Could not read or convert that file. No key values were displayed or uploaded.';
    } finally {
      // Best-effort release of references; browser memory is not secure erasure.
      text = '';
      lines.length = 0;
      addresses.clear();
      convertButton.disabled = true;
      selectedFile = null;
      fileInput.value = '';
    }
  });
})();
