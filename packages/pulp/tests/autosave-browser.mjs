/** Run with node; PLAYWRIGHT_MODULE may point to an external Playwright install. */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const viteRequire = createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json'));
const { build } = viteRequire('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const directory = await mkdtemp(join(tmpdir(), 'selfbase-autosave-'));
const output = join(directory, 'test.js');
let browser;
let server;
try {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'autosave-browser.tsx')], bundle: true, outfile: output, platform: 'browser', alias: {
    '@': join(dirname(fileURLToPath(import.meta.url)), '../../../web'),
    'spacetimedb/react': join(dirname(fileURLToPath(import.meta.url)), 'spacetime-react-fixture.ts'),
  }, format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } });
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', request.url === '/test.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/test.js' ? await readFile(output) : '<script src="/test.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => ({
    autosave: await window.runAutosaveRegression(),
    subscriptions: await window.runScopedTableRegression(),
  }));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
