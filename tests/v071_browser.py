"""UI v.0.7.1: только локальный сайт, подменённые Telegram/API/GPS/тайлы."""
import base64
from io import BytesIO
from pathlib import Path
import json
import os
import time

from PIL import Image
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=os.getenv('BROWSER_PATH','/usr/bin/chromium'))
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        context.add_init_script('''window.gpsCalls=0;window.gpsAccuracy=21;window.closedByTelegram=0;
          Object.defineProperty(navigator,'geolocation',{value:{
            getCurrentPosition(ok){window.gpsCalls++;ok({coords:{latitude:54.71,longitude:20.45,accuracy:window.gpsAccuracy},timestamp:Date.now()});},
            watchPosition(){return 1;},clearWatch(){}
          }});''')
        context.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"test-signed",ready(){},expand(){},close(){window.closedByTelegram++;}}};'))
        image=BytesIO();Image.new('RGB',(128,128),'#657847').save(image,'PNG')
        photo='data:image/png;base64,'+base64.b64encode(image.getvalue()).decode()
        leaflet=Path('web/vendor/leaflet/leaflet.js').read_text()+"\nconst originalMap=L.map;L.map=(...args)=>(window.testMap=originalMap(...args));"
        context.route('**/vendor/leaflet/leaflet.js*',lambda r:r.fulfill(content_type='text/javascript',body=leaflet))
        context.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        pet={'id':'42','name':'Луна','age':2,'description':'Генерал','color':'#397C63','photo':photo}
        live=None;calls=[];purchase_attempts=[];wallet_balance=1250000;notice_read=False

        def api(route):
            nonlocal live,notice_read
            path=route.request.url.split('/paws-api')[-1].split('?')[0]
            method=route.request.method
            if method=='OPTIONS':data={}
            else:
                calls.append((method,path))
                if path=='/api/config':data={'version':'0.7.1','closureMeters':20,'maxAccuracy':20,'demoMode':False,'features':{
                    'dossier':True,'chat':True,'wallet':True,'publicWallet':True,'liveTracking':True,'leaderboard':True,
                    'autoLiveStart':True,'crossingRoutes':True,'purchases':True,'purchasePrice':10,'territoryLeaderboard':True,'unlimitedPurchases':True,'mergeOwnPurchases':True,'foreignBuyouts':True,'notifications':True}}
                elif path=='/api/me':data={'pet':pet,'area':100}
                elif path=='/api/notifications':data={'unread':0 if notice_read else 1,'notifications':[{'id':'00000000-0000-0000-0000-000000000007','amount':'100','message':'Рекс <img src=x onerror=alert(1)> выкупил вашу территорию, вам выплачены репарации в количестве 100 🦴.','createdAt':time.time(),'read':notice_read}]}
                elif path=='/api/notifications/read':
                    assert route.request.post_data_json['ids']==['00000000-0000-0000-0000-000000000007'];notice_read=True;data={'ok':True}
                elif path=='/api/wallet':data={'balance':wallet_balance,'rate':100}
                elif path=='/api/territories':data={'territories':[],'pets':{},'truncated':False}
                elif path=='/api/walks':data={'id':'walk','startedAt':time.time()}
                elif path=='/api/walks/walk':data={'ok':True}
                elif path=='/api/live/instructions':data={'ok':True}
                elif path=='/api/live/status':data={'walk':live}
                elif path=='/api/live/capture':live=None;data={'area':100,'id':'captured'}
                elif path=='/api/top':
                    area='sort=area' in route.request.url
                    data={'agents':[{'pet':{**pet,'id':str(i),'name':f'Генерал {i}'},'area':1000-i,'wallet':{'balance':1250000 if i==1 else 900000}} for i in ([2,1] if area else [1,2])]}
                elif path.startswith('/api/pets/'):data={**pet,'wallet':{'balance':900000}}
                elif path=='/api/purchases/quote':
                    assert len(route.request.post_data_json['vertices'])>=3
                    data={'area':25000000,'selectedArea':30000000,'totalArea':35000000,'merged':True,'foreignArea':12500000,'ownersCount':2,'cost':250000000,'balance':wallet_balance,'affordable':wallet_balance>=250000000,'price':10}
                elif path=='/api/purchases':
                    purchase_attempts.append(route.request.post_data_json)
                    if len(purchase_attempts)==1:
                        route.fulfill(status=503,content_type='application/json',body='{"detail":"Временный сбой связи"}',headers={'Access-Control-Allow-Origin':'*'});return
                    data={'id':'bought','area':25000000,'totalArea':35000000,'merged':True,'cost':250000000,'reparations':[{'ownerId':'43','amount':12500000}]}
                else:raise AssertionError('Неожиданный API: '+path)
            route.fulfill(content_type='application/json',body=json.dumps(data),headers={
                'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type',
                'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'})
        context.route('https://*.supabase.co/**',api)
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
        page.goto(os.getenv('SMOKE_URL','http://127.0.0.1:8002/docs/'),wait_until='networkidle')
        assert page.title()=='DogWars. Захвати мир!'
        assert 'Добро пожаловать мой генерал' in page.locator('.header').inner_text()
        assert '20 м' in page.locator('#closure-hint').inner_text()
        assert page.locator('#open-notifications').inner_text()=='Уведомления · 1'
        page.locator('#open-notifications').click();page.locator('#notifications-dialog').wait_for(state='visible')
        assert 'вам выплачены репарации' in page.locator('#notifications-list').inner_text()
        assert page.locator('#notifications-list img').count()==0
        page.locator('#notifications-read').click();page.wait_for_function("() => document.querySelector('#open-notifications').textContent==='Уведомления'")
        page.locator('#close-notifications').click()
        assert page.locator('#wallet-balance').inner_text()=='1.25кк 🦴'
        assert ''.join(page.locator('#wallet-balance').get_attribute('title').split())=='1250000🦴'
        center=page.evaluate('() => ({center:testMap.getCenter(),zoom:testMap.getZoom()})')
        page.locator('#map-fullscreen').click()
        box=page.locator('.map-wrap').bounding_box();assert box['width']==390 and box['height']==844
        page.set_viewport_size({'width':844,'height':390})
        page.wait_for_function('() => document.querySelector(".map-wrap").getBoundingClientRect().height===390')
        page.locator('#map-fullscreen').click()
        assert page.locator('#map-fullscreen').get_attribute('aria-pressed')=='false'
        page.set_viewport_size({'width':390,'height':844})
        page.wait_for_timeout(200)
        after=page.evaluate('() => ({center:testMap.getCenter(),zoom:testMap.getZoom()})')
        assert abs(center['center']['lat']-after['center']['lat'])<.00001 and abs(center['center']['lng']-after['center']['lng'])<.00001,(center,after)
        assert center['zoom']==after['zoom']
        page.locator('#start-button').click()
        page.wait_for_function("() => document.querySelector('#status').textContent.includes('≤20')")
        assert ('POST','/api/walks') not in calls
        page.evaluate('window.gpsAccuracy=20');page.locator('#start-button').click();page.locator('#cancel-button').wait_for(state='visible')
        page.locator('#map-fullscreen').click();page.keyboard.press('Escape');assert ('DELETE','/api/walks/walk') not in calls
        page.locator('#cancel-button').click();page.locator('#cancel-button').wait_for(state='hidden')
        assert calls.count(('POST','/api/walks'))==1
        gps=page.evaluate('window.gpsCalls');page.locator('#live-start').click()
        page.wait_for_function('() => window.closedByTelegram===1')
        assert page.evaluate('window.gpsCalls')==gps
        assert ('POST','/api/live/start') not in calls
        now=time.time();live={'id':'live','error':None,'points':[{'latitude':54.71+dy,'longitude':20.45+dx,'accuracy':20,'timestamp':now-60+i*20}
            for i,(dx,dy) in enumerate([(0,0),(.001,0),(.001,.001),(0,0)])]}
        page.reload(wait_until='networkidle');page.locator('#live-panel').wait_for(state='visible')
        page.locator('#live-capture').click();page.locator('#live-panel').wait_for(state='hidden')
        page.locator('#open-top').click();page.locator('#top-body tr').first.wait_for()
        assert page.locator('.ranking-photo img').count()==2
        assert '1.25кк' in page.locator('#top-body tr').first.inner_text()
        small=page.locator('.ranking-photo img').first.bounding_box()['width']
        page.locator('.ranking-photo').first.click();page.locator('#photo-dialog').wait_for(state='visible')
        assert page.locator('#large-photo').get_attribute('src')==photo
        assert page.locator('#large-photo').bounding_box()['width']>small
        page.locator('#close-photo').click();page.locator('#top-area').click()
        page.wait_for_function("() => (document.querySelector('#top-body tr')?.textContent || '').includes('Генерал 2')")
        assert page.locator('#top-score').inner_text()=='м²'
        page.locator('#top-body .text-button').first.click();page.locator('#owner-dialog').wait_for(state='visible')
        page.wait_for_function("() => document.querySelector('#owner-bones').textContent==='🦴 900k'");page.locator('#enlarge-owner-photo').click();page.locator('#photo-dialog').wait_for(state='visible');page.locator('#close-photo').click();page.locator('#owner-done').click()
        wallet_balance=500000000
        page.reload(wait_until='networkidle')
        page.locator('#purchase-start').click();page.locator('#map-fullscreen').click();assert page.locator('.map-fullscreen #purchase-panel').is_visible()
        page.locator('#map').scroll_into_view_if_needed()
        for x,y in [(100,100),(180,100),(180,180),(100,180)]:page.locator('#map').click(position={'x':x,'y':y})
        page.wait_for_function("() => document.querySelector('#purchase-confirm').textContent.includes('250кк') && !document.querySelector('#purchase-confirm').disabled")
        assert page.locator('.purchase-point').count()==4
        assert 'Свой участок объединится' in page.locator('#purchase-status').inner_text()
        assert 'Выкупается чужая площадь' in page.locator('#purchase-status').inner_text()
        page.locator('#purchase-confirm').click()
        page.wait_for_function("() => document.querySelector('#purchase-status').textContent.includes('Временный сбой')")
        page.locator('#purchase-confirm').click();page.locator('#purchase-panel').wait_for(state='hidden')
        assert len(purchase_attempts)==2 and purchase_attempts[0]==purchase_attempts[1]
        assert purchase_attempts[0]['maxCost']==250000000
        assert page.locator('.map-fullscreen #purchase-panel').count()==0
        page.locator('#map-fullscreen').click()
        assert not errors,errors
        assert page.evaluate('() => document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path='/tmp/dogwars-v071-mobile.png',full_page=True)
        browser.close();print('v.0.7.1 UI OK: история и приватное чтение уведомлений, безопасный текст, предпросмотр выкупа, полный экран, повтор покупки.')


if __name__=='__main__':main()
