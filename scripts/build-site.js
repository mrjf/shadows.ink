import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const [source, destination] of [['index.js', 'shadows.js'], ['render.js', 'render.js'], ['physics.js', 'physics.js']]) {
  await copyFile(new URL(`src/${source}`, root), new URL(`website/${destination}`, root));
}
console.log(`Website ready: ${fileURLToPath(new URL('website/', root))}`);
