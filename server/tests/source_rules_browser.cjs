const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1200}});
 const env=process.env,errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({url,db,token})=>{
  localStorage.setItem('selfbase_workspaces_v1',JSON.stringify([{id:'rules',name:'Rule test',wsUri:url.replace(/^http/,'ws'),dbName:db}]));
  localStorage.setItem('selfbase_active_workspace_id','rules');
  localStorage.setItem('selfbase_spacetimedb_token__rules',token);
 },{url:env.SELFBASE_STDB_URL,db:env.SELFBASE_STDB_DB_NAME,token:env.SELFBASE_STDB_TOKEN});
 try{
  await page.goto(env.TEST_WEB_ORIGIN+'/workspace/'+env.TEST_DATABASE_ID,{waitUntil:'networkidle'});
  await page.getByTitle('External data source',{exact:true}).click();
  const status=page.getByLabel('Source field 3',{exact:true}).locator('..');
  assert.equal(await status.getByLabel('Value transform 3',{exact:true}).inputValue(),'statusRules');
  await status.getByLabel('Result label',{exact:true}).nth(1).fill('Working');
  await status.getByLabel('Manual labels to keep (comma separated)',{exact:false}).fill('Paused,On hold');
  const date=page.getByLabel('Source field 4',{exact:true}).locator('..');
  await date.getByText('Latest date from related records',{exact:true}).click();
  assert.equal(await date.getByLabel('Related API path with {id}',{exact:true}).inputValue(),'/item/{id}/events');
  await page.screenshot({path:'/tmp/selfbase-rules-settings.png'});
  await page.getByRole('button',{name:'Save connection',exact:true}).click();
  await page.getByText('Connection saved.',{exact:false}).waitFor();
  await page.keyboard.press('Escape');
  const row=page.locator('table tbody tr').filter({has:page.getByRole('button',{name:'Desk lamp',exact:true})});
  async function refresh(){
   await row.getByRole('button',{name:'Manage source link: Desk lamp',exact:true}).click();
   const done=page.waitForResponse(r=>r.url().includes('/api/integrations/external-source?')&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Refresh now',exact:true}).click();
   assert.equal((await done).status(),200);
   await page.keyboard.press('Escape');
  }
  await refresh();
  await row.getByText('Working',{exact:true}).waitFor();
  await row.getByText('Working',{exact:true}).dblclick();
  await page.getByRole('button',{name:'Paused',exact:true}).click();
  await row.getByText('Paused',{exact:true}).waitFor();
  await refresh();
  await row.getByText('Paused',{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/selfbase-rules-grid.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: real browser edits status rules and protected labels, displays related-date settings, refreshes Select status and preserves manual status');
 }catch(e){
  console.log((await page.locator('body').innerText()).slice(-7000));
  console.log('errors',errors);
  await page.screenshot({path:'/tmp/selfbase-rules-failure.png'});
  throw e;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
