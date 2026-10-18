const {chromium}=require('playwright');
const fs=require('node:fs/promises');
async function main(){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[]; let posts=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/quant/tactics'))posts++;});
  await page.goto('http://127.0.0.1:3001/tactics-platform');
  await page.getByText('暂无耗时统计',{exact:true}).first().waitFor();
  const response=await page.request.get('http://127.0.0.1:3001/api/quant/tactics');
  const real=await response.json();
  const d={recorded:20,cached:2,incremental:15,full:3,fallback:1,fetched_stocks:18,requests:19,rows:600,gaps:1,fetch_seconds:14,wait_seconds:5.4,validation_seconds:0.3,cache_seconds:0.1,persist_seconds:2.2,prepare_seconds:22,average_fetch_seconds:14/18,fallback_reasons:{'重叠数据变化：2026-09-08 close':1}};
  // Intercept only this page's GET response; never write public run data.
  await page.route('**/api/quant/tactics*',route=>route.fulfill({json:{data:{...real.data,runs:[{...real.data.runs[0],status:'completed',phase:'completed',total:20,processed:20,gaps:1,acquisition:d}]}}}));
  await page.reload();
  const stats=page.getByLabel('数据准备耗时统计',{exact:true});
  await stats.getByText('增量成功',{exact:true}).waitFor();
  await stats.locator('summary').click();
  await stats.getByText('重叠数据变化：2026-09-08 close：1 只',{exact:true}).waitFor();
  await fs.mkdir('data/validation/tactic-incremental',{recursive:true});
  await stats.screenshot({path:'data/validation/tactic-incremental/stats-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await stats.screenshot({path:'data/validation/tactic-incremental/stats-mobile.png'});
  const overflow=await stats.evaluate(el=>el.scrollWidth>el.clientWidth+1);
  if(overflow||posts||errors.length)throw new Error(JSON.stringify({overflow,posts,errors}));
  console.log(JSON.stringify({passed:true,legacy:true,desktop:true,mobile:true,posts,errors}));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
