// node build-standalone.mjs
// Produces worker-standalone.js: worker.js with public/index.html and
// public/app.html embedded, so the whole gateway is ONE file you can paste
// into the Cloudflare dashboard's Worker editor (no wrangler, no asset upload).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

const marker = 'const PAGES = null; // __BISMUTH_PAGES__';
const worker = read('worker.js');
if (!worker.includes(marker)) throw new Error('marker not found in worker.js');

const pages = { index: read('public/index.html'), app: read('public/app.html') };
// JSON.stringify makes valid JS; escape U+2028/2029 to be safe in older parsers.
const literal = JSON.stringify(pages).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

fs.writeFileSync(path.join(dir, 'worker-standalone.js'), worker.replace(marker, `const PAGES = ${literal};`));
console.log('wrote worker-standalone.js', (fs.statSync(path.join(dir, 'worker-standalone.js')).size / 1024).toFixed(0) + ' KB');
