import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium,webkit } from 'playwright-core';
const base = fileURLToPath(new URL('../',import.meta.url));

async function fixture(browserType,mobile = false) {
  const server = createServer(async (request,response) => {
    if (request.url === '/') {
      response.setHeader('content-type','text/html');
      response.end('<!doctype html><body><button id="start">Start</button><section id="root" style="width:320px;height:220px;background:linear-gradient(45deg,#d6cbff,#bce9d4)"><h1 class="shadows-ink" style="margin:0;font:700 32px Georgia">Moon landing</h1><p id="status"></p></section>');return;
    }
    if (!/^\/src\/[a-z]+\.js$/.test(request.url)) { response.writeHead(404);response.end();return; }
    response.setHeader('content-type','text/javascript');response.end(await readFile(base+request.url));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await browserType.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500,height: 500 },deviceScaleFactor: 1,...(mobile ? {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',isMobile: true,hasTouch: true,
  } : {}) });
  const errors = [];page.on('pageerror',error => errors.push(error.message));
  return { page,errors,url: `http://127.0.0.1:${server.address().port}/`,close: async () => { await browser.close();await new Promise(resolve => server.close(resolve)); } };
}
for (const [name,browserType] of Object.entries({ chromium,webkit })) {
  test(`${name}: plugin refreshes opted-in content and cleans up its layer without an observer loop`,async () => {
    const { page,errors,url,close } = await fixture(browserType);
    try {
      await page.goto(url);
      await page.evaluate(async () => {
        const { createShadows } = await import('/src/index.js');
        const root = document.getElementById('root');
        window.shadow = createShadows(root,{ onStatus: status => { document.getElementById('status').textContent = status.message; } });
        await window.shadow.ready;
      });
      assert.equal(await page.evaluate(() => window.shadow.status.phase),'cursor');
      await page.waitForTimeout(200);
      const first = await page.evaluate(() => Number(window.shadow.canvas.dataset.frame));
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => Number(window.shadow.canvas.dataset.frame)),first);
      await page.evaluate(() => { document.querySelector('h1').textContent = 'A longer headline on the Moon';document.getElementById('root').style.width = '390px'; });
      await page.waitForFunction(previous => Number(window.shadow.canvas.dataset.frame) > previous,first);
      assert.equal(await page.evaluate(() => window.shadow.canvas.width),390);
      await page.evaluate(async () => { window.shadow.setOptions({ gapMm: 4,pixelsPerMm: 5,material: 'graph' });await window.shadow.refresh(); });
      assert.equal(await page.evaluate(() => window.shadow.options.gapMm),4);
      await page.evaluate(() => window.shadow.setLight({ direction: [1,0,1] }));
      await page.waitForFunction(() => window.shadow.status.phase === 'manual');
      const before = await page.evaluate(() => document.querySelector('h1').style.cssText);
      await page.evaluate(() => window.shadow.destroy());
      assert.equal(await page.locator('[data-shadows-ink]').count(),0);
      assert.equal(await page.evaluate(() => document.getElementById('root').style.position),'');
      assert.equal(await page.evaluate(() => document.getElementById('root').style.isolation),'');
      assert.equal(await page.evaluate(() => document.querySelector('h1').style.cssText),before);
      assert.equal(await page.evaluate(() => window.shadow.status.phase),'destroyed');
      assert.deepEqual(errors,[]);
    } finally { await close(); }
  });

  test(`${name}: mobile permissions and calibration are explicit and destroy releases sensors`,async () => {
    const { page,errors,url,close } = await fixture(browserType,true);
    try {
      await page.addInitScript(() => {
        window.sensor = { requested: 0,watches: 0,cleared: 0,permission: 'denied' };
        Object.defineProperty(DeviceOrientationEvent,'requestPermission',{ value: async () => { window.sensor.requested++;return window.sensor.permission; } });
        Object.defineProperty(navigator.geolocation,'watchPosition',{ value: success => {
          window.sensor.watches++;queueMicrotask(() => success({ coords: { latitude: 37.77,longitude: -122.42,accuracy: 20 } }));return 1;
        } });
        Object.defineProperty(navigator.geolocation,'clearWatch',{ value: () => { window.sensor.cleared++; } });
        window.emitOrientation = () => {
          const event = new Event('deviceorientation');
          Object.defineProperties(event,{ alpha: { value: 30 },beta: { value: 0 },gamma: { value: 0 },absolute: { value: false },webkitCompassHeading: { value: 80 },webkitCompassAccuracy: { value: 10 } });
          dispatchEvent(event);
        };
      });
      await page.clock.setFixedTime(new Date('2026-06-21T19:00:00Z'));
      await page.goto(url);
      await page.evaluate(async () => {
        const { createShadows } = await import('/src/index.js');
        window.shadow = createShadows(document.getElementById('root'));
        document.getElementById('start').onclick = () => window.shadow.startSunlight();
        await window.shadow.ready;
      });
      assert.equal(await page.evaluate(() => window.shadow.status.phase),'setup');
      assert.equal(await page.evaluate(() => window.sensor.requested),0);
      assert.equal(await page.evaluate(() => window.shadow.canvas.dataset.lit),'false');
      await page.locator('#start').click();
      await page.waitForFunction(() => window.shadow.status.action === 'retry');
      assert.match(await page.evaluate(() => window.shadow.status.message),/Motion is blocked/);
      assert.equal(await page.evaluate(() => window.sensor.watches),0);
      await page.evaluate(() => { window.sensor.permission = 'granted'; });
      await page.locator('#start').click();
      await page.waitForFunction(() => window.sensor.watches === 1);
      await page.evaluate(() => window.emitOrientation());
      await page.waitForFunction(() => window.shadow.status.phase === 'calibration');
      assert.equal(await page.evaluate(() => window.shadow.status.canCalibrate),true);
      assert.equal(await page.evaluate(() => window.shadow.canvas.dataset.lit),'false');
      assert.equal(await page.evaluate(() => window.shadow.calibrate()),true);
      await page.waitForFunction(() => window.shadow.status.label === 'Live · compass');
      assert.equal(await page.evaluate(() => window.shadow.canvas.dataset.lit),'true');
      await page.evaluate(() => window.shadow.destroy());
      assert.equal(await page.evaluate(() => window.sensor.cleared),1);
      assert.equal(await page.locator('[data-shadows-ink]').count(),0);
      assert.deepEqual(errors,[]);
    } finally { await close(); }
  });
}
