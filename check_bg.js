const { chromium } = require('/Users/husnainali/cinehome-app/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://hussyserver:4445/movie/27205', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const style = await page.evaluate(() => {
    const el = document.querySelector('.absolute.inset-0.z-0');
    return {
      bgColor: el ? getComputedStyle(el).backgroundColor : null,
      bgImage: el ? getComputedStyle(el).backgroundImage : null,
    };
  });
  console.log('BG COLOR:', style.bgColor);
  console.log('BG IMAGE:', style.bgImage);

  for (const y of [700, 1300, 1600, 2000, 2300]) {
    await page.evaluate((yy) => window.scrollTo(0, Math.max(0, yy - 450)), y);
    await page.waitForTimeout(150);
    const viewportY = y - Math.max(0, y - 450);
    const elAtPoint = await page.evaluate((vy) => {
      const el = document.elementFromPoint(700, vy);
      return el ? el.tagName + '.' + (el.className || '').toString().slice(0, 60) : 'none';
    }, viewportY);
    const buf = await page.screenshot({ clip: { x: 690, y: Math.max(0, viewportY - 5), width: 20, height: 10 } });
    require('fs').writeFileSync(`/Users/husnainali/.claude/jobs/73826bb3/tmp/pixel4-${y}.png`, buf);
    console.log(`y=${y} elementAtPoint=${elAtPoint}`);
  }
  await browser.close();
})();
