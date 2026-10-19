const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ wsUri, dbName, token }) => {
    localStorage.setItem('selfbase_workspaces_v1', JSON.stringify([{ id: 'title-check', name: 'Local integration test', wsUri, dbName }]));
    localStorage.setItem('selfbase_active_workspace_id', 'title-check');
    localStorage.setItem('selfbase_spacetimedb_token__title-check', token);
  }, { wsUri: process.env.SELFBASE_STDB_URL.replace(/^http/, 'ws'), dbName: process.env.SELFBASE_STDB_DB_NAME, token: process.env.SELFBASE_STDB_TOKEN });
  try {
    await page.goto(`${process.env.TEST_WEB_ORIGIN}/workspace/${process.env.TEST_DATABASE_ID}`, { waitUntil: 'networkidle' });
    const tbody = page.locator('table tbody');
    await tbody.getByRole('button', { name: 'Untitled', exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole('columnheader', { name: 'External record', exact: true }).count(), 0, 'Legacy metadata column is visible');
    await tbody.getByRole('button', { name: 'Untitled', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search external records' });
    await search.waitFor();
    await search.fill('desk');
    await search.locator('..').getByRole('button', { name: 'Desk lamp', exact: true }).click();
    await search.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => [...document.querySelectorAll('table tbody button')].filter(b => b.textContent === 'Desk lamp').length === 2);
    let customRow = tbody.locator('tr').filter({ has: page.getByRole('button', { name: 'My custom title', exact: true }) });
    await customRow.getByRole('button', { name: 'Link to source: My custom title', exact: true }).click();
    await search.waitFor();
    assert.equal(await search.inputValue(), 'My custom title', 'Existing title was not used for search');
    await search.fill('desk');
    await search.locator('..').getByRole('button', { name: 'Desk lamp', exact: true }).click();
    await search.waitFor({ state: 'hidden' });
    customRow = tbody.locator('tr').filter({ has: page.getByRole('button', { name: 'My custom title', exact: true }) });
    await customRow.getByRole('button', { name: 'Manage source link: My custom title', exact: true }).waitFor();
    assert.ok((await customRow.textContent()).includes('80h 3m'), 'Duration was not populated');
    assert.ok((await customRow.textContent()).includes('17'), 'Numeric field was not populated');
    assert.equal(await customRow.getByRole('button', { name: 'My custom title', exact: true }).count(), 1);
    assert.equal(new URL(page.url()).pathname, `/workspace/${process.env.TEST_DATABASE_ID}`, 'Picker event navigated away from the database');
    await page.screenshot({ path: '/tmp/selfbase-source-title-grid.png', fullPage: true });
    await customRow.getByRole('button', { name: 'Manage source link: My custom title', exact: true }).click();
    await page.getByRole('button', { name: 'Unlink · keep values', exact: true }).click();
    await customRow.getByRole('button', { name: 'Link to source: My custom title', exact: true }).waitFor();
    assert.ok((await customRow.textContent()).includes('80h 3m'), 'Unlink erased mapped statistics');
    await page.getByTitle('List view', { exact: true }).click();
    await page.getByRole('button', { name: 'Link to source: My custom title', exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await page.getByText('External record', { exact: true }).count(), 0);
    assert.deepEqual(errors, [], 'Browser runtime errors');
    console.log('PASS: real browser Untitled -> source search -> name/fields; custom title preserved; metadata hidden; unlink preserves statistics; list actions available');
  } catch (error) {
    console.error('Page errors:', errors);
    console.error((await page.locator('body').innerText()).slice(-6000));
    await page.screenshot({ path: '/tmp/selfbase-source-title-failure.png', fullPage: true });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
