import { test, expect } from '@playwright/test';

test('debug page content', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.goto(baseURL + '/Auth/Login');
  await page.waitForSelector('table.login:not(.hidden)', { timeout: 15000 });
  await page.fill('#txtUsername', 'admin');
  await page.fill('#txtPassword', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/ServerConfig**', { timeout: 15000 });
  
  // Devices page  
  await page.goto(page.url().split('#')[0] + '#devices');
  await page.waitForTimeout(8000);
  const devicesHtml = await page.innerHTML('#applicationHost');
  require('fs').writeFileSync('../temp/devices-html.txt', devicesHtml);

  // Security page
  await page.goto(page.url().split('#')[0] + '#security');
  await page.waitForTimeout(5000);
  const secHtml = await page.innerHTML('#applicationHost');
  require('fs').writeFileSync('../temp/security-html.txt', secHtml);
});
