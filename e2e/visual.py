import asyncio,json,os,shutil
from pathlib import Path
from playwright.async_api import async_playwright
BASE=os.environ.get('SHUV_URL','http://127.0.0.1:3080')
OUT=Path(os.environ.get('SHUV_SCREENSHOTS','qa'));OUT.mkdir(exist_ok=True,parents=True)
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  errors=[];report=[]
  for name,w,h,reduce in [('desktop',1440,1000,False),('mobile',390,844,False),('small',360,640,False),('reduced',1440,1000,True)]:
   ctx=await browser.new_context(viewport={'width':w,'height':h},device_scale_factor=1,reduced_motion='reduce' if reduce else 'no-preference')
   await ctx.add_init_script("Element.prototype.requestPointerLock=function(){};Element.prototype.setPointerCapture=function(){}")
   page=await ctx.new_page();page.on('pageerror',lambda err:errors.append(str(err)))
   await page.goto(BASE+'/',wait_until='networkidle');await page.wait_for_timeout(300)
   for section in ['hero','experiment','close']:
    sel={'hero':'.sf-hero','experiment':'#try-it','close':'.sf-close'}[section]
    loc=page.locator(sel)
    if await loc.count():
     await loc.scroll_into_view_if_needed();await page.wait_for_timeout(300)
    await page.screenshot(path=str(OUT/f'{name}-landing-{section}.png'))
   overflow=await page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   await page.goto(BASE+'/guest/',wait_until='networkidle');await page.get_by_role('heading',name='נחזיר היום שיחה טובה.').wait_for();await page.wait_for_timeout(200)
   await page.screenshot(path=str(OUT/f'{name}-today.png'))
   report.append({'device':name,'landingOverflow':overflow,'guestOverflow':await page.evaluate('document.documentElement.scrollWidth>innerWidth+1'),'matches':await page.locator('.sf-opportunity').count(),'guestWithoutAccount':True})
   await page.get_by_role('button',name='בדיקת ההודעה').first.click();await page.locator('dialog').wait_for(state='visible');await page.wait_for_timeout(350);await page.screenshot(path=str(OUT/f'{name}-message.png'))
   await page.get_by_role('button',name='סגירה',exact=True).click()
   await page.goto(BASE+'/guest/?tab=leads',wait_until='networkidle');await page.get_by_role('heading',name='מאחורי כל פנייה, יש סיפור.').wait_for();await page.screenshot(path=str(OUT/f'{name}-leads.png'))
   report[-1]['leadsOverflow']=await page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   await page.goto(BASE+'/guest/?tab=results',wait_until='networkidle');await page.wait_for_timeout(300);await page.screenshot(path=str(OUT/f'{name}-results.png'))
   await ctx.close()
  assert not errors,errors
  assert all(not d['landingOverflow'] and not d['guestOverflow'] and not d['leadsOverflow'] for d in report),report
  await browser.close()
  (OUT/'visual-report.json').write_text(json.dumps({'devices':report,'errors':errors},ensure_ascii=False,indent=2))
  print(json.dumps({'devices':report,'errors':errors},ensure_ascii=False,indent=2))
asyncio.run(main())
