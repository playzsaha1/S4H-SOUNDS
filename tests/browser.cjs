// Run: NODE_PATH=<path-to-playwright-node_modules> node tests/browser.cjs
// Fixture: ffmpeg -f lavfi -i sine=frequency=440:duration=1 -c:a libmp3lame work/tone.mp3
// Start server with COUNTER_DB=work/test-counter.sqlite3 (isolated test data).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.TEST_URL || 'http://localhost:8000';
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], completions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/complete')) completions.push(JSON.parse(request.postData())); });
  const count = async () => (await (await page.request.get(base + '/api/count')).json()).total;
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('#convertBtn').disabled);
  try {
    await page.goto(base);
    const startCount = await count();
    assert.equal(await page.locator('#panel-converter').isVisible(), false);
    assert.equal(await page.getByRole('link', { name: 'Converter', exact: true }).isVisible(), false);
    await page.getByRole('link', {name:'Privacy', exact:true}).click();
    assert.equal(new URL(page.url()).pathname, '/privacy');
    assert.equal(await page.getByRole('link', { name: 'Converter', exact: true }).isVisible(), false);
    assert.equal(await page.locator('#headerStart').isVisible(), false);
    await page.getByRole('link', { name: 'Back to Home' }).first().click();
    await page.locator('#headerStart').click();
    assert.equal(new URL(page.url()).pathname, '/app');
    assert.equal(await page.locator('#publicFooter').isVisible(), false);
    assert.equal(await page.locator('#publicNav').isVisible(), false);
    assert.equal(await page.locator('#convertBtn').isDisabled(), true);
    for (const text of ['AAC', 'FLAC', 'OGG']) assert.equal(await page.getByRole('button', {name:new RegExp(text)}).isDisabled(), true);
    await page.getByRole('link', {name:'Downloads', exact:true}).click();
    assert.equal(await page.getByText('No converted files yet.').isVisible(), true);
    await page.reload();
    assert.equal(new URL(page.url()).pathname, '/app/downloads');
    await page.getByRole('link', {name:'Converter', exact:true}).click();
    await page.locator('#fileInput').setInputFiles({name:'bad.txt', mimeType:'text/plain', buffer:Buffer.from('no')});
    assert.match(await page.locator('#statusText').textContent(), /Choose a non-empty MP3/);
    assert.equal(await page.locator('#convertBtn').isDisabled(), true);
    await page.locator('#fileInput').setInputFiles({name:'empty.mp3', mimeType:'audio/mpeg', buffer:Buffer.alloc(0)});
    assert.equal(await page.locator('#convertBtn').isDisabled(), true);
    await page.locator('#fileInput').setInputFiles({name:'damaged.mp3', mimeType:'audio/mpeg', buffer:Buffer.from('ID3broken')});
    await page.locator('#convertBtn').click(); await waitIdle();
    assert.match(await page.locator('#statusText').textContent(), /could not be decoded/);
    assert.equal(await page.locator('#convertBtn').textContent(), 'Retry conversion');
    assert.equal(await count(), startCount);
    const fixture = await fs.readFile('work/tone.mp3');
    await page.locator('#fileInput').setInputFiles({name:'tone.mp3', mimeType:'audio/mpeg', buffer:fixture});
    assert.match(await page.locator('#fileSizeLabel').textContent(), /KB/);
    await page.locator('#convertBtn').click(); await waitIdle();
    assert.match(await page.locator('#statusText').textContent(), /Success/);
    assert.equal(await count(), startCount + 1);
    let downloadEvent = page.waitForEvent('download');
    await page.locator('#result a').click();
    let download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'tone.wav');
    await download.saveAs('work/test-tone.wav');
    const wav = await fs.readFile('work/test-tone.wav');
    assert.equal(wav.toString('ascii',0,4), 'RIFF'); assert.equal(wav.toString('ascii',8,12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length > 80000);
    const replay = await page.evaluate(async token => (await (await fetch('/api/complete', {method:'POST',headers:{'Content-Type':'application/json','X-S4H-Request':'conversion'},body:JSON.stringify({token})})).json()).total, completions[0].token);
    assert.equal(replay, startCount + 1);
    assert.equal(await count(), startCount + 1);
    await page.locator('#fileInput').setInputFiles({name:'a<&"song.mp3', mimeType:'audio/mpeg', buffer:fixture});
    await page.getByRole('button', {name:'XML Data',exact:true}).click();
    await page.locator('#convertBtn').click(); await waitIdle();
    assert.equal(await count(), startCount + 2);
    downloadEvent = page.waitForEvent('download'); await page.locator('#result a').click(); download = await downloadEvent;
    await download.saveAs('work/test-manifest.xml');
    const xml = await fs.readFile('work/test-manifest.xml', 'utf8');
    assert.match(xml, /a&lt;&amp;&quot;song/); assert.match(xml, /<channels>1<\/channels>/);
    assert.match(xml, /metadata-only/); assert.doesNotMatch(xml, /128 kbps|stereo/);
    const parsed = await page.evaluate(text => {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      return { valid: !doc.querySelector('parsererror'), name:doc.querySelector('fileName')?.textContent };
    }, xml);
    assert.deepEqual(parsed, {valid:true,name:'a<&"song.mp3'});
    await page.getByRole('link', {name:'Downloads',exact:true}).click();
    assert.equal(await page.locator('#downloadsList a').count(), 2);
    await page.screenshot({path:'work/downloads-desktop.png',fullPage:true});
    await page.reload(); assert.equal(await count(), startCount + 2);
    assert.equal(await page.getByText('No converted files yet.').isVisible(), true);
    // Delay decoder completion, cancel during real in-flight processing, verify no event.
    await page.getByRole('link', {name:'Converter',exact:true}).click();
    await page.evaluate(() => {
      const original = AudioContext.prototype.decodeAudioData;
      window.originalDecode = original;
      AudioContext.prototype.decodeAudioData = async function (...args) {
        const decoded = await original.apply(this, args);
        await new Promise(resolve => setTimeout(resolve, 500)); return decoded;
      };
    });
    await page.locator('#fileInput').setInputFiles('work/tone.mp3'); await page.locator('#convertBtn').click();
    await page.locator('#cancelBtn').click(); await waitIdle();
    assert.match(await page.locator('#statusText').textContent(), /cancelled/);
    assert.equal(await count(), startCount + 2);
    await page.evaluate(() => { AudioContext.prototype.decodeAudioData = window.originalDecode; });
    // Real conversion remains usable with the API down.
    await page.route('**/api/**', route => route.abort());
    await page.locator('#convertBtn').click(); await waitIdle();
    assert.match(await page.locator('#statusText').textContent(), /Success/);
    assert.match(await page.locator('#counterNote').textContent(), /not recorded/);
    assert.equal(await page.locator('#result a').isVisible(), true);
    await page.unroute('**/api/**');
    assert.equal(await count(), startCount + 2);
    // A second independent browser context sees the same global total.
    const other = await browser.newPage(); await other.goto(base + '/app');
    await other.waitForFunction(() => /conversions/.test(document.querySelector('#conversionCount').textContent));
    assert.equal(await other.locator('#conversionCount').textContent(), `${startCount + 2} conversions`); await other.close();
    for (const width of [375, 320, 768, 1440]) {
      await page.setViewportSize({width,height:900});
      for (const path of ['/', '/privacy', '/app', '/app/downloads']) {
        await page.goto(base + path);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} ${path}`);
        if (width === 375 || width === 1440) await page.screenshot({path:`work/${width}-${path.replaceAll('/','_') || 'home'}-dark.png`,fullPage:true});
      }
    }
    await page.goto(base + '/'); await page.locator('#themeToggle').click();
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'light');
    await page.reload(); assert.equal(await page.locator('body').getAttribute('data-theme'), 'light');
    await page.screenshot({path:'work/landing-light.png',fullPage:true});
    await page.goto(base + '/app'); await page.screenshot({path:'work/app-light.png',fullPage:true});
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'light');
    assert.ok(completions.every(body => Object.keys(body).length === 1 && typeof body.token === 'string'));
    assert.deepEqual(errors, []);
    console.log('PASS: routes, navigation boundaries, formats, validation, WAV/XML bytes, downloads, global counter, deduplication, refresh, cancellation, backend outage, themes and responsive layouts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
