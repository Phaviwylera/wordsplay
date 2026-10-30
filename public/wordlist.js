(() => {
  const pageSize = 128;
  const $ = selector => document.querySelector(selector);
  let words = [];
  let page = 0;
  function render() {
    const query = $('#word-search').value.trim().toLowerCase();
    const matching = words.filter(item => !query || item.word.includes(query) || String(item.number) === query);
    const pages = Math.max(1, Math.ceil(matching.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const start = page * pageSize;
    const selected = matching.slice(start, start + pageSize);
    const list = $('#word-list');
    list.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const { word, number } of selected) {
      const row = document.createElement('li');
      const index = document.createElement('span');
      const text = document.createElement('strong');
      index.textContent = number;
      text.textContent = word;
      row.append(index, text);
      fragment.append(row);
    }
    list.append(fragment);
    $('#word-count').textContent = `${matching.length.toLocaleString()} of ${words.length.toLocaleString()} words`;
    $('#word-empty').hidden = matching.length > 0;
    $('#word-pager').hidden = matching.length <= pageSize;
    $('#word-page-label').textContent = `Page ${page + 1} of ${pages}`;
    $('#word-prev').disabled = page === 0;
    $('#word-next').disabled = page >= pages - 1;
  }
  $('#word-search').addEventListener('input', () => { page = 0; render(); });
  $('#word-prev').addEventListener('click', () => { page--; render(); });
  $('#word-next').addEventListener('click', () => { page++; render(); });
  fetch('/bip39-english.txt').then(response => {
    if (!response.ok) throw new Error('Could not load list');
    return response.text();
  }).then(text => {
    const list = text.trim().split(/\r?\n/);
    if (list.length !== 2048 || new Set(list).size !== 2048 || list.some(word => !/^[a-z]+$/.test(word))) throw new Error('Invalid word list');
    words = list.map((word, index) => ({ word, number: index + 1 }));
    render();
  }).catch(() => {
    $('#word-count').textContent = 'Could not load the word list. Refresh the page to try again.';
    $('#word-search').disabled = true;
  });
})();
