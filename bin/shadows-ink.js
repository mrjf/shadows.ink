#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Usage: shadows-ink [command] [options]

Commands:
  demo                    Serve the packaged demo (default)
  serve [directory]       Serve a local project (default: current directory)
  init <directory>        Create a starter project without overwriting files

Options:
  --port <number>         Server port (default: 4321; 0 chooses an available port)
  --host <host>           Server host (default: localhost)
  --help, -h             Show this help
  --version, -v          Show the package version

Examples:
  npx shadows.ink
  npx shadows.ink demo --port 8080
  npx shadows.ink init my-shadows
  npx shadows.ink serve my-shadows
`;

function parseArguments(args) {
  const positionals = [];
  const flags = new Map();
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.set('help', true);
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.set('version', true);
      continue;
    }
    const match = /^--(port|host)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unknown option: ${arg}. Run shadows-ink --help.`);
    const key = match[1];
    if (flags.has(key)) throw new Error(`Option --${key} was supplied more than once.`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${key} needs a value.`);
    flags.set(key, value);
  }
  const command = positionals[0] ?? 'demo';
  if (!['demo', 'serve', 'init'].includes(command)) throw new Error(`Unknown command: ${command}. Run shadows-ink --help.`);
  if (positionals.length > (command === 'demo' ? 1 : 2)) throw new Error(`Too many arguments for ${command}.`);
  if (flags.has('help') || flags.has('version')) return { help: flags.has('help'), version: flags.has('version') };
  if (command === 'init') {
    if (flags.has('port') || flags.has('host')) throw new Error('The init command does not accept server options.');
    if (!positionals[1]) throw new Error('Choose a destination: shadows-ink init <directory>.');
  }
  const port = flags.get('port') ?? '4321';
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('--port must be an integer from 0 to 65535.');
  const host = flags.get('host') ?? 'localhost';
  if (host.length > 253 || !/^[a-zA-Z0-9_.:-]+$/.test(host)) throw new Error('--host must be a hostname or IP address, without a URL scheme.');
  return { command, directory: positionals[1], port: Number(port), host };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

function isInside(root, path) {
  const offset = relative(root, path);
  return offset !== '..' && !offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(offset);
}

async function serve(directory, { host, port, command }) {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const reply = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : `${message}\n`);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      reply(405, 'Method not allowed');
      return;
    }
    let pathname;
    try {
      if (!request.url?.startsWith('/')) throw new Error('Invalid request target');
      pathname = decodeURIComponent(request.url.split(/[?#]/, 1)[0]);
    } catch {
      reply(400, 'Invalid URL');
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      reply(403, 'Forbidden');
      return;
    }
    try {
      let path = await realpath(resolve(root, `.${pathname}`));
      if (!isInside(root, path)) {
        reply(403, 'Forbidden');
        return;
      }
      let info = await stat(path);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) {
          const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
          response.writeHead(301, { Location: `${request.url.split(/[?#]/, 1)[0]}/${query}` });
          response.end();
          return;
        }
        path = await realpath(join(path, 'index.html'));
        if (!isInside(root, path)) {
          reply(403, 'Forbidden');
          return;
        }
        info = await stat(path);
      }
      if (!info.isFile()) {
        reply(404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
      });
      if (request.method === 'HEAD') response.end();
      else {
        const stream = createReadStream(path);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      reply(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500,
        error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Could not read file');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const displayHost = host.includes(':') ? `[${host}]` : host;
  console.log(`Shadows.ink ${command}: http://${displayHost}:${address.port}/`);
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function starterFiles(version) {
  return {
    'package.json': `${JSON.stringify({
      name: 'my-shadows', version: '1.0.0', private: true, type: 'module',
      scripts: { start: 'shadows-ink serve .' }, dependencies: { 'shadows.ink': version },
    }, null, 2)}\n`,
    'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shadows.ink</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main>
    <h1><span class="shadows-ink">Sunlight</span></h1>
    <p id="status" role="status"></p>
    <button id="setup" type="button" hidden>Set up sunlight</button>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`,
    'style.css': `:root { font-family: system-ui, sans-serif; color: #20201e; background: #f5f3ec; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; }
main { text-align: center; padding: 1.5rem; }
h1 { margin: 0; font-size: clamp(3rem, 14vw, 8rem); line-height: 1.2; }
#status { max-width: 28rem; margin: 2rem auto 1rem; }
button { font: inherit; min-height: 44px; padding: 0.6rem 1rem; cursor: pointer; }
button:disabled { cursor: default; }
`,
    'shadows.config.js': `export default {
  gapMm: 0,
  thicknessMm: 3,
  material: 'smooth',
};
`,
    'main.js': `import { createShadows } from './node_modules/shadows.ink/src/index.js';
import config from './shadows.config.js';

const status = document.querySelector('#status');
const setup = document.querySelector('#setup');
const shadows = createShadows(document.body, {
  ...config,
  onStatus(state) {
    status.textContent = state.message;
    setup.hidden = !state.action;
    setup.textContent = state.actionLabel || 'Set up sunlight';
    setup.disabled = state.action === 'calibrate' && !state.canCalibrate;
  },
});

setup.addEventListener('click', () => {
  if (shadows.status.action === 'calibrate') shadows.calibrate();
  else shadows.startSunlight();
});

shadows.ready.catch(error => {
  status.textContent = error.message;
  setup.hidden = true;
});
`,
    'README.md': `# My shadows

Install the library and serve this folder:

\`\`\`sh
npm install
npx shadows.ink serve .
\`\`\`

Open the URL printed in your terminal. On desktop, move the pointer to simulate sunlight. On a phone, use the setup button to allow location and motion, then follow the compass instructions. Phone sensors need HTTPS; publish these static files to an HTTPS host before opening them on another device.

Add the \`shadows-ink\` class to each element that should cast a shadow. Configure the physical distance and thickness in millimeters in \`shadows.config.js\`. Keep setup controls outside marked elements.
`,
  };
}

async function init(directory, version) {
  const destination = resolve(directory);
  const files = starterFiles(version);
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error(`Destination is not a directory: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of Object.keys(files)) {
    try {
      await lstat(join(destination, name));
      throw new Error(`Refusing to overwrite ${join(destination, name)}. Choose a new directory.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(destination, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(destination, name), contents, { flag: 'wx' });
  }
  console.log(`Created ${destination}\nInside that directory, run:\n  npm install\n  npx shadows.ink serve .`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const { version } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (options.help) console.log(help);
  else if (options.version) console.log(version);
  else if (options.command === 'init') await init(options.directory, version);
  else await serve(options.command === 'demo' ? join(packageRoot, 'website') : resolve(options.directory ?? '.'), options);
} catch (error) {
  console.error(`shadows-ink: ${error.message}`);
  process.exitCode = 1;
}
