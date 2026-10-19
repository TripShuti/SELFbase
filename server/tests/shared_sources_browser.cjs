const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const env = process.env;
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ wsUri, dbName, token }) => {
    localStorage.setItem('selfbase_workspaces_v1', JSON.stringify([{ id: 'shared-check', name: 'Shared sources test', wsUri, dbName }]));
    localStorage.setItem('selfbase_active_workspace_id', 'shared-check');
    localStorage.setItem('selfbase_spacetimedb_token__shared-check', token);
  }, { wsUri: env.SELFBASE_STDB_URL.replace(/^http/, 'ws'), dbName: env.SELFBASE_STDB_DB_NAME, token: env.SELFBASE_STDB_TOKEN });
  try {
    await page.goto(env.TEST_WEB_ORIGIN + '/workspace/settings', { waitUntil: 'networkidle' });
    const section = page.locator('#data-sources');
    await section.getByText('Updated inventory', { exact: true }).waitFor();
    await section.getByRole('button', { name: 'Edit', exact: true }).click();
    await section.getByLabel('Connection name', { exact: true }).fill('Browser edited inventory');
    await section.getByRole('button', { name: 'Save source', exact: true }).click();
    await section.getByText('Browser edited inventory', { exact: true }).waitFor();
    await section.getByRole('button', { name: '+ New Source', exact: true }).click();
    await section.getByLabel('Connection name', { exact: true }).fill('Unused public service');
    await section.getByLabel('Base URL', { exact: false }).fill('http://public-service:8080');
    await section.getByText('Authentication', { exact: true }).click();
    await section.getByLabel('Header name', { exact: false }).fill('');
    await section.getByRole('button', { name: 'Save source', exact: true }).click();
    const unused = section.locator('div.flex.items-center').filter({ hasText: 'Unused public service' });
    await unused.getByRole('button', { name: 'Remove', exact: true }).click();
    await section.getByText('Unused public service', { exact: true }).waitFor({ state: 'hidden' });
    await page.goto(env.TEST_WEB_ORIGIN + '/workspace/' + env.TEST_THIRD_DATABASE_ID, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Data source', exact: true }).click();
    await page.getByLabel('Workspace source', { exact: true }).selectOption('inventory');
    await page.getByLabel('Copy mappings from database', { exact: true }).selectOption(env.TEST_DATABASE_ID);
    await page.getByText('Copied 2 of 2 mappings', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('Source field 1', { exact: true }).inputValue(), 'elapsed');
    assert.equal(await page.getByLabel('Source field 2', { exact: true }).inputValue(), 'stock');
    assert.equal(await page.getByLabel('Credential', { exact: false }).count(), 0);
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await page.getByText('Connection saved.', { exact: false }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('table tbody').getByRole('button', { name: 'Untitled', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Search external records', exact: true });
    await search.fill('lamp');
    await search.locator('..').getByRole('button', { name: 'Desk lamp', exact: true }).click();
    const row = page.locator('table tbody tr').filter({ has: page.getByRole('button', { name: 'Desk lamp', exact: true }) });
    await row.getByText('80h 3m', { exact: true }).waitFor();
    await row.getByText('17', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/selfbase-shared-source-browser.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: real browser workspace source create/edit/delete, database selection without key, copying mappings, name and mapped values populated');
  } catch (error) {
    console.log((await page.locator('body').innerText()).slice(-7000));
    console.log('page errors:', errors);
    await page.screenshot({ path: '/tmp/selfbase-shared-source-failure.png' });
    throw error;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
