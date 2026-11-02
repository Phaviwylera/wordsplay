'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

(async () => {
  const root = path.resolve(__dirname, '..');
  const template = fs.readFileSync(path.join(root, 'src/offline-private-key-converter.template.html'), 'utf8');
  const built = await esbuild.build({
    entryPoints: [path.join(root, 'src/offline-private-key-converter.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2022'],
    minify: true,
    write: false,
  });
  const marker = '/* OFFLINE_CONVERTER_BUNDLE */';
  if (template.split(marker).length !== 2) throw new Error('Offline converter template must contain exactly one bundle marker.');
  const html = template.replace(marker, built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
  fs.writeFileSync(path.join(root, 'public/offline-private-key-converter.html'), html, { mode: 0o644 });
})().catch(error => {
  console.error('Could not build the offline private-key converter.');
  process.exitCode = 1;
});
