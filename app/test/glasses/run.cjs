// Runs the real bridge.js (from the Android shell) and GlassesDevice.js in headless Chromium against
// fake-channel.js, which mimics the Kotlin side of the WebMessage protocol.
//   node test/glasses/run.cjs        (from app/, after npm install)
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const app = path.resolve(__dirname, '../..');
const assets = path.resolve(app, '../android/app/src/main/assets');
const files = {
  '/test.html': path.join(__dirname, 'test.html'),
  '/fake-channel.js': path.join(__dirname, 'fake-channel.js'),
  '/bridge.js': path.join(assets, 'bridge.js'),
  '/letter.jpg': path.join(assets, 'mock/letter.jpg'),
  '/js/devices/GlassesDevice.js': path.join(app, 'public/js/devices/GlassesDevice.js'),
  '/js/devices/VelaDevice.js': path.join(app, 'public/js/devices/VelaDevice.js'),
};
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/js/api.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('export function log(t,d={}){(window.__logs ||= []).push({type:t,...d})}'); }
  const f = files[url];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const p = await b.newPage(); p.on('console', (m) => console.log('console:', m.text())); p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.goto(`http://127.0.0.1:${port}/test.html`);
  await p.waitForFunction(() => window.__done, null, { timeout: 20000 });
  const r = await p.evaluate(() => window.__done);
  for (const t of r) console.log(t.pass ? 'PASS' : 'FAIL', t.name, t.pass ? '' : JSON.stringify(t.extra || ''));
  console.log(r.filter((t) => t.pass).length + '/' + r.length + ' passed');
  await b.close(); server.close();
  process.exit(r.every((t) => t.pass) ? 0 : 1);
});
