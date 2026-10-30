const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { wordlists } = require('ethers');

const text = fs.readFileSync('public/bip39-english.txt', 'utf8');
const words = text.trim().split(/\r?\n/);
const html = fs.readFileSync('public/wordlist.html', 'utf8');
const script = fs.readFileSync('public/wordlist.js', 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('local list contains all 2048 official English BIP-39 words in order', () => {
  assert.equal(words.length, 2048);
  assert.equal(new Set(words).size, 2048);
  assert.equal(words[0], 'abandon');
  assert.equal(words[2047], 'zoo');
  assert.ok(words.every((word, i) => word === wordlists.en.getWord(i)));
  assert.equal(createHash('sha256').update(text).digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  assert.match(fs.readFileSync('public/bip39-wordlist-LICENSE.txt', 'utf8'), /MIT License/);
});

test('word reference searches and paginates locally without storing input', async () => {
  const dom = new JSDOM(html, { url: 'https://wallet.example/wordlist', runScripts: 'outside-only' });
  const w = dom.window; const urls = [];
  w.fetch = async url => { urls.push(url); return { ok: true, text: async () => text }; };
  w.eval(script); await tick();
  const $ = id => w.document.getElementById(id);
  assert.equal($('word-list').children.length, 128);
  assert.match($('word-count').textContent, /2,048 of 2,048/);
  assert.equal($('word-list').children[0].textContent, '1abandon');
  assert.equal($('word-prev').disabled, true);
  $('word-next').click();
  assert.equal($('word-list').children[0].textContent, `129${words[128]}`);
  assert.match($('word-page-label').textContent, /Page 2 of 16/);
  $('word-search').value = 'ABANDON'; $('word-search').dispatchEvent(new w.Event('input'));
  assert.equal($('word-list').children.length, 1);
  assert.equal($('word-list').children[0].textContent, '1abandon');
  assert.equal($('word-pager').hidden, true);
  $('word-search').value = '2048'; $('word-search').dispatchEvent(new w.Event('input'));
  assert.equal($('word-list').children[0].textContent, '2048zoo');
  $('word-search').value = 'notaword'; $('word-search').dispatchEvent(new w.Event('input'));
  assert.equal($('word-list').children.length, 0);
  assert.equal($('word-empty').hidden, false);
  assert.deepEqual(urls, ['/bip39-english.txt']);
  assert.equal(w.localStorage.length, 0);
  dom.window.close();
});

test('word reference reports load errors without fabricating a list', async () => {
  const dom = new JSDOM(html, { url: 'https://wallet.example/wordlist', runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = async () => ({ ok: false });
  w.eval(script); await tick();
  assert.match(w.document.getElementById('word-count').textContent, /Could not load/);
  assert.equal(w.document.getElementById('word-search').disabled, true);
  assert.equal(w.document.getElementById('word-list').children.length, 0);
  dom.window.close();
});

test('dashboard and Vercel expose the word reference and local list', () => {
  const dashboard = fs.readFileSync('public/index.html', 'utf8');
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assert.match(dashboard, /href="\/wordlist"/);
  for (const source of ['/wordlist', '/wordlist.js', '/bip39-english.txt', '/bip39-wordlist-LICENSE.txt']) assert.ok(config.rewrites.some(route => route.source === source));
});
