// Renders the PWA icons from the wordmark with the brand fonts (headless Chromium).
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
for (const [size, pad, name] of [[192, 0, 'icon-192.png'], [512, 0, 'icon-512.png'], [512, 0.12, 'icon-512-maskable.png']]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>@font-face{font-family:F;src:url(http://127.0.0.1:8410/fonts/fraunces-normal.woff2)}
  body{margin:0;width:${size}px;height:${size}px;background:#13110F;display:flex;align-items:center;justify-content:center}
  span{font-family:F;font-weight:500;font-size:${size * (0.62 - pad)}px;color:#F4EFE6;line-height:1;letter-spacing:-0.01em;transform:translateY(-${size * 0.04}px)}
  i{display:inline-block;width:.28em;height:.28em;border-radius:50%;background:#F0A23A;margin-left:.08em}</style><span>v<i></i></span>`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(200);
  await p.screenshot({ path: `public/icons/${name}` });
}
await b.close();
