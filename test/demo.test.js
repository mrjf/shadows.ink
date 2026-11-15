import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';

async function fixture(type, mobile = false) {
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://local').pathname.slice(1) || 'index.html';
    if (!/^[a-z.-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(new URL(`../website/${name}`, import.meta.url));
      res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await type.launch({ headless: true });
  const page = await browser.newPage({ viewport: mobile ? {width:390,height:844} : {width:1280,height:900}, ...(mobile ? {isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'} : {}) });
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => Number(document.getElementById('scene').dataset.frame) > 0);
  return {page,errors,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
const frame = page => page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const light = page => page.evaluate(()=>{
  const gl=document.getElementById('scene').getContext('webgl2'), p=gl.getParameter(gl.CURRENT_PROGRAM);
  return {sun:Array.from(gl.getUniform(p,gl.getUniformLocation(p,'sun'))),point:gl.getUniform(p,gl.getUniformLocation(p,'usePointLight'))};
});
async function compare(page, before, after) {
  return page.evaluate(async ([a,b])=>{
    async function pixels(base64) {const img=new Image();img.src=`data:image/png;base64,${base64}`;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {data:ctx.getImageData(0,0,c.width,c.height).data,width:c.width};}
    const x=await pixels(a),y=await pixels(b);let changed=0;
    for(let i=0;i<x.data.length;i+=4) if(Math.abs(x.data[i]-y.data[i])+Math.abs(x.data[i+1]-y.data[i+1])+Math.abs(x.data[i+2]-y.data[i+2])>12) changed++;
    const at=(image,px,py)=>Array.from(image.data.slice((py*image.width+px)*4,(py*image.width+px)*4+3));
    return {changed,paperBefore:at(x,10,60),paperAfter:at(y,10,60)};
  },[before.toString('base64'),after.toString('base64')]);
}
for(const [name,type] of Object.entries({chromium,webkit})) {
  test(`${name}: drawn sun vectors change visible shadows, hold on release, and do not light the paper`,async()=>{
    const {page,errors,close}=await fixture(type);
    try {
      assert.equal(await page.locator('#shadow-page button, #shadow-page a, #shadow-page input').count(),0);
      assert.equal(await page.locator('#shadow-page .shadows-ink').count(),8);
      const phone=await page.locator('.phone').boundingBox(),controls=await page.locator('.workbench').boundingBox();
      assert.ok(controls.x>phone.x+phone.width);
      const before=await page.locator('#shadow-page').screenshot();
      const initial=await light(page);assert.equal(initial.point,0);
      await page.mouse.move(120,180);await page.mouse.down();await page.mouse.move(550,390,{steps:5});await frame(page);
      assert.equal(await page.locator('#sun-vector').isVisible(),true);
      assert.match(await page.locator('#sun-vector-angle').textContent(),/°/);
      const drawn=await light(page);assert.ok(drawn.sun[0]<0&&drawn.sun[1]>0&&drawn.sun[2]>0);
      assert.ok(drawn.sun[2]<initial.sun[2]);
      await page.mouse.up();await frame(page);
      assert.equal(await page.locator('#sun-vector').isVisible(),false);
      await page.mouse.move(900,100);await frame(page);assert.deepEqual(await light(page),drawn);
      const after=await page.locator('#shadow-page').screenshot(),change=await compare(page,before,after);
      assert.ok(change.changed>800,`Only ${change.changed} rendered pixels changed`);
      assert.deepEqual(change.paperBefore,[255,250,240]);assert.deepEqual(change.paperAfter,change.paperBefore);
      await page.locator('#sun-angle').fill('70');await frame(page);assert.ok((await light(page)).sun[2]>.9);
      await page.locator('#vector-reset').click();await frame(page);assert.deepEqual(await light(page),initial);
      assert.deepEqual(errors,[]);
    } finally {await close();}
  });
  test(`${name}: article and external setup fit a phone, including a long permission instruction`,async()=>{
    const {page,errors,close}=await fixture(type,true);
    try {
      for(const viewport of [{width:390,height:844},{width:320,height:568}]) {
        await page.setViewportSize(viewport);
        await page.locator('#status').evaluate(el=>el.textContent='Location is blocked. In Safari’s page menu, open Website Settings → Location → Allow. Then tap Retry.');
        await frame(page);
        const bounds=await page.evaluate(()=>({page:document.getElementById('shadow-page').getBoundingClientRect().toJSON(),story:document.querySelector('.story').getBoundingClientRect().toJSON(),controls:document.querySelector('.workbench').getBoundingClientRect().toJSON(),fits:document.documentElement.scrollHeight<=innerHeight}));
        assert.ok(bounds.story.bottom<=bounds.page.bottom+1,JSON.stringify(bounds));
        assert.ok(bounds.controls.top>=bounds.page.bottom);assert.ok(bounds.controls.bottom<=viewport.height);assert.ok(bounds.fits);
      }
      assert.equal(await page.locator('#scene').getAttribute('data-lit'),'false');
      assert.equal(await page.locator('#sun-control').isVisible(),false);assert.deepEqual(errors,[]);
    } finally {await close();}
  });
}
