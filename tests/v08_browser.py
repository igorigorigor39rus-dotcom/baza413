"""UI v.0.8: только локальный сайт, подменённые Telegram/API/GPS/тайлы."""
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
            watchPosition(ok){window.gpsCallback=ok;return 1;},clearWatch(){window.watchCleared=true;}
          }});''')
        context.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"test-signed",ready(){},expand(){},close(){window.closedByTelegram++;},openInvoice(url,cb){window.invoiceUrl=url;window.invoiceCallback=cb;}}};'))
        image=BytesIO();Image.new('RGB',(128,128),'#657847').save(image,'PNG')
        photo='data:image/png;base64,'+base64.b64encode(image.getvalue()).decode()
        leaflet=Path('web/vendor/leaflet/leaflet.js').read_text()+"\nconst originalMap=L.map;L.map=(...args)=>(window.testMap=originalMap(...args));"
        context.route('**/vendor/leaflet/leaflet.js*',lambda r:r.fulfill(content_type='text/javascript',body=leaflet))
        context.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        pet={'id':'42','name':'Луна','age':2,'description':'Генерал','color':'#397C63','photo':photo}
        invoice_paid=False;reminders=True;largest=True
        live=None;live_result=None;calls=[];purchase_attempts=[];wallet_balance=1250000;notice_read=False

        def api(route):
            nonlocal live,live_result,notice_read,reminders
            path=route.request.url.split('/paws-api')[-1].split('?')[0]
            method=route.request.method
            if method=='OPTIONS':data={}
            else:
                calls.append((method,path))
                if path=='/api/config':data={'version':'0.8.0','closureMeters':20,'maxAccuracy':20,'demoMode':False,'features':{
                    'dossier':True,'chat':True,'wallet':True,'publicWallet':True,'liveTracking':True,'leaderboard':True,
                    'autoLiveStart':True,'crossingRoutes':True,'purchases':True,'purchasePrice':10,'territoryLeaderboard':True,'unlimitedPurchases':True,'mergeOwnPurchases':True,'foreignBuyouts':True,'notifications':True,'speedLimit':True,'maxSpeedKmh':20,'starShop':True,'reminders':True,'largestTerritory':True}}
                elif path=='/api/activity':
                    assert route.request.post_data_json['timezone'];data={'enabled':reminders,'timezone':'Europe/Kaliningrad'}
                elif path=='/api/reminders':reminders=route.request.post_data_json['enabled'];data={'enabled':reminders}
                elif path=='/api/shop':data={'debt':0,'packages':[{'id':str(stars),'stars':stars,'bones':bones} for stars,bones in [(100,10000),(250,30000),(500,80000),(1000,200000)]]}
                elif path=='/api/shop/invoice':data={'url':'https://t.me/$test','orderId':'order'}
                elif path=='/api/shop/orders/order':data={'paid':invoice_paid,'refunded':False}
                elif path.endswith('/largest-territory'):
                    data={'territory':{'id':'largest','area':23456,'geometry':{'type':'Polygon','coordinates':[[[30,60],[30.001,60],[30.001,60.001],[30,60.001],[30,60]]]}} if largest else None}
                elif path=='/api/me':data={'pet':pet,'area':100}
                elif path=='/api/notifications':data={'unread':0 if notice_read else 1,'notifications':[{'id':'00000000-0000-0000-0000-000000000007','amount':'100','message':'Рекс <img src=x onerror=alert(1)> выкупил вашу территорию, вам выплачены репарации в количестве 100 🦴.','createdAt':time.time(),'read':notice_read}]}
                elif path=='/api/notifications/read':
                    assert route.request.post_data_json['ids']==['00000000-0000-0000-0000-000000000007'];notice_read=True;data={'ok':True}
                elif path=='/api/wallet':data={'balance':wallet_balance,'rate':100}
                elif path=='/api/territories':data={'territories':[],'pets':{},'truncated':False}
                elif path=='/api/walks':data={'id':'walk','startedAt':time.time()}
                elif path=='/api/walks/walk':data={'ok':True}
                elif path=='/api/live/instructions':data={'ok':True}
                elif path=='/api/live/status':data={'walk':live,'result':live_result}
                elif path in ('/api/capture','/api/live/capture'):
                    failure={'annulled':True,'code':'SPEED_LIMIT','walkId':'live' if path.endswith('live/capture') else 'walk','averageSpeedKmh':40,'detail':'Ай яй яй, захват аннулирован, играй честно'}
                    if path.endswith('live/capture'):live=None;live_result=failure
                    route.fulfill(status=422,content_type='application/json',body=json.dumps(failure),headers={'Access-Control-Allow-Origin':'*'});return
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
        page.locator('#profile-button').click()
        page.locator('#reminders-settings').wait_for(state='visible')
        page.locator('#reminders-enabled').uncheck();page.wait_for_function("() => document.querySelector('#reminders-status').textContent.includes('отключены')")
        assert not reminders
        page.locator('#show-my-territory').click();page.locator('#profile-dialog').wait_for(state='hidden')
        page.wait_for_function('() => testMap.getCenter().lat>59')
        assert page.locator('#map-fullscreen').get_attribute('aria-pressed')=='true'
        page.locator('#map-fullscreen').click()
        page.locator('#open-shop').click();page.locator('#shop-packages button').nth(3).wait_for()
        assert page.locator('#shop-packages button').count()==4
        assert '200' in page.locator('#shop-packages button').nth(3).inner_text()
        page.locator('#shop-packages button').first.click();page.wait_for_function('() => window.invoiceUrl')
        assert wallet_balance==1250000
        invoice_paid=True;wallet_balance+=10000
        page.evaluate("() => window.invoiceCallback('paid')")
        page.wait_for_function("() => document.querySelector('#shop-status').textContent.includes('Оплата подтверждена')")
        page.locator('#close-shop').click()
        page.locator('#start-button').click()
        page.wait_for_function("() => document.querySelector('#status').textContent.includes('≤20')")
        assert ('POST','/api/walks') not in calls
        page.evaluate('window.gpsAccuracy=20');page.locator('#start-button').click();page.locator('#cancel-button').wait_for(state='visible')
        page.locator('#map-fullscreen').click();page.keyboard.press('Escape');assert ('DELETE','/api/walks/walk') not in calls
        page.evaluate('''() => {const now=Date.now();for(const [i,lat,lon] of [[1,54.71,20.451],[2,54.711,20.451],[3,54.71,20.45]])gpsCallback({coords:{latitude:lat,longitude:lon,accuracy:20},timestamp:now+i*1000});}''')
        page.locator('#capture-button').click()
        page.wait_for_function("() => document.querySelector('#status').textContent==='Ай яй яй, захват аннулирован, играй честно'")
        page.locator('#cancel-button').wait_for(state='hidden')
        assert page.evaluate('window.watchCleared') is True
        assert ('DELETE','/api/walks/walk') not in calls
        assert calls.count(('POST','/api/walks'))==1
        gps=page.evaluate('window.gpsCalls');page.locator('#live-start').click()
        page.wait_for_function('() => window.closedByTelegram===1')
        assert page.evaluate('window.gpsCalls')==gps
        assert ('POST','/api/live/start') not in calls
        now=time.time();live={'id':'live','error':None,'points':[{'latitude':54.71+dy,'longitude':20.45+dx,'accuracy':20,'timestamp':now-27+i*9}
            for i,(dx,dy) in enumerate([(0,0),(.001,0),(.001,.001),(0,0)])]}
        page.reload(wait_until='networkidle');page.locator('#live-panel').wait_for(state='visible')
        page.locator('#live-capture').click();page.locator('#live-panel').wait_for(state='hidden')
        assert page.locator('#status').inner_text()=='Ай яй яй, захват аннулирован, играй честно'
        page.reload(wait_until='networkidle')
        assert page.locator('#status').inner_text()=='Ай яй яй, захват аннулирован, играй честно'
        assert page.locator('#start-button').is_visible()
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
        page.wait_for_function("() => document.querySelector('#owner-bones').textContent==='🦴 900k'");page.locator('#enlarge-owner-photo').click();page.locator('#photo-dialog').wait_for(state='visible');page.locator('#close-photo').click()
        largest=False;page.locator('#show-owner-territory').click()
        page.wait_for_function("() => document.querySelector('#owner-territory-status').textContent.includes('пока нет')")
        assert page.locator('#owner-dialog').is_visible()
        largest=True;page.locator('#show-owner-territory').click();page.locator('#owner-dialog').wait_for(state='hidden')
        page.wait_for_function('() => testMap.getCenter().lat>59');page.locator('#map-fullscreen').click()
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
        page.screenshot(path='/tmp/dogwars-v08-mobile.png',full_page=True)
        browser.close();print('v.0.8 UI OK: окончательный отказ в обоих режимах, отключение GPS, восстановление причины, прежние покупки и уведомления.')


if __name__=='__main__':main()
