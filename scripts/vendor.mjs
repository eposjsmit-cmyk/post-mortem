// Copies the third-party libraries the site needs into vendor/, so GitHub Pages can serve
// plain files with no build step. Run after `npm install`: `npm run vendor`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);
const out = (p) => join(root, 'vendor', p);

for (const d of ['vendor', 'vendor/stockfish', 'vendor/chessground', 'vendor/fonts']) mkdirSync(join(root, d), { recursive: true });

// Handwriting fonts for the Sketchbook theme (only downloaded when that theme is on).
copyFileSync(nm('@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff2'), out('fonts/patrick-hand.woff2'));
copyFileSync(nm('@fontsource/caveat/files/caveat-latin-700-normal.woff2'), out('fonts/caveat-700.woff2'));

// Stockfish: the lite single-threaded WASM build (needs no special server headers) plus the asm.js fallback.
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-asm.js']) {
  copyFileSync(nm(`stockfish/bin/${f}`), out(`stockfish/${f}`));
}

// chess.js (rules) and chessground (board) already ship as single ES modules.
copyFileSync(nm('chess.js/dist/esm/chess.js'), out('chess.js'));
copyFileSync(nm('chessground/dist/chessground.min.js'), out('chessground/chessground.js'));
for (const f of ['chessground.base.css', 'chessground.brown.css', 'chessground.cburnett.css']) {
  copyFileSync(nm(`chessground/assets/${f}`), out(`chessground/${f}`));
}

// Anthropic SDK: bundled once into a single browser module.
await build({
  entryPoints: [nm('@anthropic-ai/sdk/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  outfile: out('anthropic-sdk.js'),
  logLevel: 'warning',
});

// Licences travel with the code.
const licences = [
  ['Stockfish (GPL-3.0)', 'stockfish/Copying.txt'],
  ['chess.js (BSD-2-Clause)', 'chess.js/LICENSE'],
  ['chessground (GPL-3.0)', 'chessground/LICENSE'],
  ['@anthropic-ai/sdk (MIT)', '@anthropic-ai/sdk/LICENSE'],
  ['Patrick Hand font (SIL Open Font License 1.1)', '@fontsource/patrick-hand/LICENSE'],
  ['Caveat font (SIL Open Font License 1.1)', '@fontsource/caveat/LICENSE'],
];
let text = 'Third-party libraries bundled in this folder\n\n';
for (const [name, file] of licences) {
  try {
    text += `==== ${name} ====\n${readFileSync(nm(file), 'utf8')}\n\n`;
  } catch {
    text += `==== ${name} ====\n(see the package on npm)\n\n`;
  }
}
writeFileSync(out('LICENSES.txt'), text);
console.log('vendor/ updated');
