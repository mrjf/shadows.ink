import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, webkit } from 'playwright-core';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'shadows-ink-install-'));
const consumer = join(scratch, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runNpm = (args, cwd) => exec(npm, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
let server;

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Installed Shadows.ink consumer</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 24px; background: white; }
  #surface { width: 480px; height: 300px; background: rgb(210, 233, 205); }
  #marked { position: absolute; left: 40px; top: 40px; margin: 0; font: 28px/1.2 Georgia, serif; color: #152018; }
  #image { position: absolute; left: 320px; top: 64px; width: 64px; height: 64px; }
  #control { position: absolute; left: 40px; top: 210px; width: 200px; height: 44px; padding: 0; border: 1px solid #152018; background: transparent; color: #152018; font: 20px Georgia, serif; }
</style>
<div id="surface">
  <p id="marked" class="shadows-ink">Cast this text</p>
  <img id="image" class="shadows-ink" src="./circle.svg" alt="A circle with transparent corners" width="64" height="64">
  <button id="control">An ordinary button</button>
</div>
<script type="module">
  import { createShadows, drawElementMask } from './node_modules/shadows.ink/src/index.js';
  const root = document.getElementById('surface');
  const api = createShadows(root, { mode: 'manual', gapMm: 2, thicknessMm: 0, pixelsPerMm: 4, material: 'smooth' });
  const regions = { text: [20, 20, 250, 110], control: [20, 190, 250, 275] };
  const count = (pixels, width, bounds, flipped = false, threshold = 0) => {
    let total = 0;
    const height = pixels.length / width / 4;
    for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
      if (pixels[((flipped ? height - 1 - y : y) * width + x) * 4 + 3] > threshold) total++;
    }
    return total;
  };
  window.fixture = {
    api,
    async snapshot() {
      await api.refresh();
      await new Promise(requestAnimationFrame);
      const canvas = api.canvas, gl = canvas.getContext('webgl2');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const alphaAt = (x, y) => pixels[((canvas.height - 1 - y) * canvas.width + x) * 4 + 3];
      let maxAlpha = 0;
      for (let i = 3; i < pixels.length; i += 4) maxAlpha = Math.max(maxAlpha, pixels[i]);
      const mask = document.createElement('canvas'); mask.width = 480; mask.height = 300;
      const context = mask.getContext('2d', { willReadFrequently: true });
      drawElementMask(context, root);
      const coverage = context.getImageData(0, 0, mask.width, mask.height).data;
      const maskAt = (x, y) => coverage[(y * mask.width + x) * 4 + 3];
      return {
        status: api.status.phase, alpha: gl.getContextAttributes().alpha,
        paperAlpha: alphaAt(460, 280), imageShadowAlpha: alphaAt(324, 96), maxAlpha,
        maskText: count(coverage, mask.width, regions.text), maskControl: count(coverage, mask.width, regions.control),
        imageCenter: maskAt(352, 96), imageCorner: maskAt(321, 65),
        textShadow: count(pixels, canvas.width, regions.text, true, 20),
        controlShadow: count(pixels, canvas.width, regions.control, true, 20),
      };
    },
  };
  await api.ready;
  api.setLight({ direction: [Math.SQRT1_2, 0, Math.SQRT1_2], altitude: 45 });
  await window.fixture.snapshot();
  window.fixture.ready = true;
</script></html>`;

async function screenshotColors(page) {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async png => {
    const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const bounds = document.getElementById('surface').getBoundingClientRect();
    const rgb = (x, y) => Array.from(context.getImageData(bounds.left + x, bounds.top + y, 1, 1).data).slice(0, 3);
    return { paper: rgb(460, 280), imageShadow: rgb(324, 96) };
  }, png);
}

try {
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  await runNpm(['pack', '--silent', '--pack-destination', scratch], packageRoot);
  const archives = (await readdir(scratch)).filter(name => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack must produce one installable archive');
  const archive = join(scratch, archives[0]);
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'shadows-ink-install-consumer', private: true, type: 'module' }));
  await runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive], consumer);
  const installedPath = join(consumer, 'node_modules', 'shadows.ink');
  const installedStat = await lstat(installedPath);
  assert.ok(installedStat.isDirectory() && !installedStat.isSymbolicLink(), 'npm must unpack the tarball into an actual directory');
  const installedRoot = await realpath(installedPath);
  const consumerRoot = await realpath(consumer);
  assert.ok(installedRoot.startsWith(consumerRoot + sep), 'the consumer must install its own package, not link to the source checkout');
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, metadata.version);
  const cli = await runNpm(['exec', '--offline', '--no', '--', 'shadows-ink', '--version'], consumer);
  assert.equal(cli.stdout.trim(), metadata.version, 'npm exec must run the installed package CLI');
  await writeFile(join(consumer, 'index.html'), html);
  await writeFile(join(consumer, 'circle.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#9c4527"/></svg>');
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = resolve(consumer, '.' + (pathname === '/' ? '/index.html' : pathname));
    const offset = relative(consumer, filename);
    if (offset === '..' || offset.startsWith('..' + sep)) { response.writeHead(403).end(); return; }
    try {
      const contents = await readFile(filename);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[extname(filename)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }); response.end(contents);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let tested = 0;
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    if (!existsSync(browserType.executablePath())) { console.log(`SKIP ${name}: browser is not installed`); continue; }
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
      const errors = [], modules = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().endsWith('.js')) modules.push(new URL(request.url()).pathname); });
      await page.goto(url);
      await page.waitForFunction(() => window.fixture?.ready, undefined, { timeout: 15000 });
      const initial = await page.evaluate(() => window.fixture.snapshot());
      assert.equal(initial.status, 'manual', `${name}: the installed renderer must start`);
      assert.equal(initial.alpha, true, `${name}: the added layer must have transparency`);
      assert.equal(initial.paperAlpha, 0, `${name}: unshadowed background must stay transparent`);
      assert.ok(initial.imageShadowAlpha > 30, `${name}: the image must cast a displaced shadow`);
      assert.ok(initial.maskText > 100 && initial.textShadow > 100, `${name}: the opted-in paragraph must cast a shadow`);
      assert.equal(initial.imageCenter, 255, `${name}: image alpha must enter the mask`);
      assert.equal(initial.imageCorner, 0, `${name}: transparent image corners must stay clear`);
      assert.equal(initial.maskControl, 0, `${name}: unmarked control must not enter the mask`);
      assert.equal(initial.controlShadow, 0, `${name}: unmarked control must not cast a shadow`);
      assert.deepEqual(modules.sort(), ['/node_modules/shadows.ink/src/index.js', '/node_modules/shadows.ink/src/physics.js', '/node_modules/shadows.ink/src/render.js']);
      const raisedColors = await screenshotColors(page);
      assert.deepEqual(raisedColors.paper, [210, 233, 205], `${name}: the regular site's background must remain visible`);
      assert.ok(raisedColors.imageShadow.every((value, i) => value < raisedColors.paper[i] - 20), `${name}: the transparent layer must visibly darken the underlying page`);

      const flat = await page.evaluate(async () => {
        window.fixture.api.setOptions({ gapMm: 0, thicknessMm: 0 }); return window.fixture.snapshot();
      });
      assert.equal(flat.maxAlpha, 0, `${name}: zero gap and thickness must remove every cast shadow`);
      assert.deepEqual((await screenshotColors(page)).imageShadow, [210, 233, 205], `${name}: flattening must restore the original background`);

      const removed = await page.evaluate(async () => {
        window.fixture.api.setOptions({ gapMm: 2 });
        document.getElementById('marked').classList.remove('shadows-ink');
        return window.fixture.snapshot();
      });
      assert.equal(removed.maskText, 0, `${name}: removing the opt-in class must remove its silhouette`);
      assert.equal(removed.textShadow, 0, `${name}: refresh must remove the old paragraph shadow`);
      assert.ok(removed.imageShadowAlpha > 30, `${name}: removing one opt-in must preserve the other`);
      const added = await page.evaluate(async () => {
        document.getElementById('control').classList.add('shadows-ink'); return window.fixture.snapshot();
      });
      assert.ok(added.maskControl > 100 && added.controlShadow > 100, `${name}: adding the class and refreshing must opt the control in`);
      const restored = await page.evaluate(async () => {
        document.getElementById('control').classList.remove('shadows-ink');
        document.getElementById('marked').classList.add('shadows-ink'); return window.fixture.snapshot();
      });
      assert.equal(restored.maskControl, 0, `${name}: removing the class must clear the control mask`);
      assert.equal(restored.controlShadow, 0, `${name}: removing the class must clear the control shadow`);
      assert.ok(restored.maskText > 100 && restored.textShadow > 100, `${name}: re-adding the paragraph must restore its shadow`);
      const cleanup = await page.evaluate(() => {
        window.fixture.api.destroy();
        const root = document.getElementById('surface');
        return { canvases: root.querySelectorAll('canvas').length, position: root.style.position, isolation: root.style.isolation };
      });
      assert.deepEqual(cleanup, { canvases: 0, position: '', isolation: '' }, `${name}: destroy must restore the ordinary page`);
      assert.deepEqual(errors, [], `${name}: the installed consumer must not report browser errors`);
      tested++; console.log(`PASS ${name}: installed package, transparent shadows, opt-in classes and configuration`);
    } finally { await browser.close(); }
  }
  assert.ok(tested > 0, 'Install a Playwright Chromium or WebKit browser before running test:install');
  console.log(`PASS npm pack/install and npm exec shadows-ink --version (${metadata.version})`);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
