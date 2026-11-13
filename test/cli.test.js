import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = new URL('../bin/shadows-ink.js', import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'shadows-ink-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'website'));
  await copyFile(source, join(root, 'bin/shadows-ink.js'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'shadows.ink', version: '0.1.0', type: 'module' }));
  await writeFile(join(root, 'website/index.html'), '<h1>Packaged demo</h1>');
  await writeFile(join(root, 'website/demo.js'), 'export const sunlight = true;');
  await writeFile(join(root, 'website/surface.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'private.txt'), 'outside the web root');
  return root;
}

function run(root, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/shadows-ink.js'), ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function start(t, root, args) {
  const child = spawn(process.execPath, [join(root, 'bin/shadows-ink.js'), ...args], { cwd: root });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${stdout} ${stderr}`)), 5000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = /http:\/\/[^\s]+\//.exec(stdout);
      if (match) {
        clearTimeout(timeout);
        resolve(new URL(match[0]));
      }
    });
  });
}

function get(url, path = '/', method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('demo serves packaged assets and rejects traversal, symlink escapes, and invalid requests', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'private.txt'), join(root, 'website/escape.txt'));
  const url = await start(t, root, ['--port', '0']);
  assert.equal(url.hostname, 'localhost');
  const index = await get(url);
  assert.equal(index.status, 200);
  assert.match(index.body, /Packaged demo/);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const script = await get(url, '/demo.js?cache=1');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal((await get(url, '/surface.svg')).headers['content-type'], 'image/svg+xml');
  const head = await get(url, '/demo.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);
  assert.equal((await get(url, '/missing.js')).status, 404);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/%5c..%5cprivate.txt', '/escape.txt']) {
    const result = await get(url, path);
    assert.equal(result.status, 403, path);
    assert.doesNotMatch(result.body, /outside the web root/);
  }
  assert.equal((await get(url, '/%ZZ')).status, 400);
  assert.equal((await get(url, '/', 'POST')).status, 405);
});

test('serve uses an explicit local directory and preserves directory URL semantics', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'project/nested'), { recursive: true });
  await writeFile(join(root, 'project/index.html'), '<h1>My project</h1>');
  await writeFile(join(root, 'project/nested/index.html'), '<script src="./app.js"></script>');
  const url = await start(t, root, ['serve', 'project', '--host=127.0.0.1', '--port=0']);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match((await get(url)).body, /My project/);
  assert.equal((await get(url, '/demo.js')).status, 404);
  const redirect = await get(url, '/nested?check=1');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/nested/?check=1');
  assert.equal((await get(url, '/nested/')).status, 200);
});

test('init creates a usable dependency and refuses to overwrite existing destination files', async t => {
  const root = await fixture(t);
  const result = await run(root, ['init', 'my-project']);
  assert.equal(result.code, 0, result.stderr);
  const destination = join(root, 'my-project');
  const packageJson = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['shadows.ink'], '0.1.0');
  assert.equal(packageJson.scripts.start, 'shadows-ink serve .');
  assert.match(await readFile(join(destination, 'main.js'), 'utf8'), /from '\.\/node_modules\/shadows\.ink\/src\/index\.js'/);
  assert.match(await readFile(join(destination, 'index.html'), 'utf8'), /class="shadows-ink"/);
  assert.match(await readFile(join(destination, 'main.js'), 'utf8'), /import config from '\.\/shadows\.config\.js'/);
  assert.match(await readFile(join(destination, 'shadows.config.js'), 'utf8'), /gapMm: 0/);
  const readme = await readFile(join(destination, 'README.md'), 'utf8');
  assert.match(readme, /npm install/);
  assert.match(readme, /npx shadows\.ink serve \./);
  await writeFile(join(destination, 'index.html'), '<h1>Keep my edits</h1>');
  const repeat = await run(root, ['init', 'my-project']);
  assert.equal(repeat.code, 1);
  assert.match(repeat.stderr, /Refusing to overwrite/);
  assert.equal(await readFile(join(destination, 'index.html'), 'utf8'), '<h1>Keep my edits</h1>');
  await mkdir(join(root, 'existing'));
  await writeFile(join(root, 'existing/main.js'), 'custom code');
  const conflict = await run(root, ['init', 'existing']);
  assert.equal(conflict.code, 1);
  assert.deepEqual(await readdir(join(root, 'existing')), ['main.js']);
  assert.equal(await readFile(join(root, 'existing/main.js'), 'utf8'), 'custom code');
});

test('help, version, and invalid arguments finish without starting a server', async t => {
  const root = await fixture(t);
  const version = await run(root, ['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), '0.1.0');
  const help = await run(root, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /init <directory>/);
  for (const args of [['--wat'], ['demo', 'extra'], ['init'], ['init', 'example', '--port', '80'], ['--port', '-1'], ['--port', '65536'], ['--port', '1.2'], ['--host', 'https://localhost'], ['--port'], ['--port', '1', '--port', '2']]) {
    const result = await run(root, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /^shadows-ink:/);
  }
});
