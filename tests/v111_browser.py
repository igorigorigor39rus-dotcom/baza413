"""UI v.1.1.1: только локальный сайт, подменённые Telegram/API/GPS/тайлы."""
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
        context.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"test-signed",isVersionAtLeast(){return true;},requestFullscreen(){window.hqFullscreen=true;},exitFullscreen(){window.hqFullscreen=false;},ready(){},expand(){},close(){window.closedByTelegram++;},openInvoice(url,cb){window.invoiceUrl=url;window.invoiceCallback=cb;}}};'))
        image=BytesIO();Image.new('RGB',(128,128),'#657847').save(image,'PNG')
        photo='data:image/png;base64,'+base64.b64encode(image.getvalue()).decode()
        leaflet=Path('web/vendor/leaflet/leaflet.js').read_text()+"\nconst originalMap=L.map;L.map=(...args)=>(window.testMap=originalMap(...args));"
        context.route('**/vendor/leaflet/leaflet.js*',lambda r:r.fulfill(content_type='text/javascript',body=leaflet))
        context.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        breed_catalog=json.loads(Path('web/assets/breeds.json').read_text())
        default_breed={'id': 'Q39295', 'name': 'Сибирский хаски', 'aliases': ['Siberian Husky', 'Хаски', 'Сибирская лайка'], 'family': 'spitz'}
        pet={'profileId':'11111111-1111-4111-8111-111111111111','breedId':default_breed['id'],'breedName':default_breed['name'],'breedFamily':default_breed['family'],'id':'42','name':'Луна','age':2,'description':'Генерал','color':'#397C63','photo':photo}
        invoice_paid=False;reminders=True;largest=True
        hq_level=1;hq_attempts=[];delete_attempts=[];secondary=None;pending=None;account_role="primary"
        world_allowed=False;local_allowed=True;chat_posts=[];chat_history={'district':[],'city':[],'world':[]}
        live=None;live_result=None;calls=[];purchase_attempts=[];wallet_balance=1250000;notice_read=False

        def api(route):
            nonlocal live,live_result,notice_read,reminders,hq_level,wallet_balance,secondary,pending,pet
            path=route.request.url.split('/paws-api')[-1].split('?')[0]
            method=route.request.method
            if method=='OPTIONS':data={}
            else:
                calls.append((method,path))
                if path=='/api/config':data={'version':'1.1.1','closureMeters':20,'maxAccuracy':20,'demoMode':False,'features':{
                    'dossier':True,'chat':True,'wallet':True,'publicWallet':True,'liveTracking':True,'leaderboard':True,
                    'autoLiveStart':True,'crossingRoutes':True,'purchases':True,'purchasePrice':10,'territoryLeaderboard':True,'unlimitedPurchases':True,'mergeOwnPurchases':True,'foreignBuyouts':True,'notifications':True,'speedLimit':True,'maxSpeedKmh':20,'starShop':True,'reminders':True,'largestTerritory':True,'dailyIncome':True,'geoChat':True,'liveOnly':True,'extraCamouflage':True,'breeds':True,'headquarters':True,'sharedPet':True,'unlimitedGpsGap':True,'landscapeHQ':True,'deletePet':True,'highQualityHQ':True}}
                elif path=='/api/accounts':data={'role':account_role,'primaryId':'42','secondary':secondary,'pending':pending}
                elif path=='/api/accounts/invite':
                    if method=='POST':
                        assert route.request.post_data_json['username']=='https://t.me/second_general'
                        pending={'username':'second_general','expiresAt':time.time()+86400}
                    else:pending=None
                    data={'role':'primary','primaryId':'42','secondary':secondary,'pending':pending,**({'url':'https://t.me/test_bot?start=link_'+'a'*32}if method=='POST'else{})}
                elif path=='/api/accounts/secondary':
                    secondary=None;pending=None;data={'role':'primary','primaryId':'42','secondary':None,'pending':None}
                elif path=='/api/hq':data={'level':hq_level,'progress':(hq_level-1)*100/9,'maxLevel':10,'nextCost':100000*2**(hq_level-1) if hq_level<10 else None,'balance':wallet_balance,'affordable':hq_level<10 and wallet_balance>=100000*2**(hq_level-1)}
                elif path=='/api/hq/upgrade':
                    body=route.request.post_data_json;hq_attempts.append(body)
                    if len(hq_attempts)==1:
                        route.fulfill(status=503,content_type='application/json',body='{"detail":"Проверка повтора запроса"}',headers={'Access-Control-Allow-Origin':'*'});return
                    assert body['expectedLevel']==hq_level
                    cost=100000*2**(hq_level-1);wallet_balance-=cost;hq_level+=1
                    data={'cost':cost,'headquarters':{'level':hq_level,'progress':(hq_level-1)*100/9,'maxLevel':10,'nextCost':cost*2,'balance':wallet_balance,'affordable':wallet_balance>=cost*2}}
                elif path=='/api/chat':
                    from urllib.parse import urlparse,parse_qs
                    body=route.request.post_data_json if method=='POST' else {}
                    channel=body['channel'] if method=='POST' else parse_qs(urlparse(route.request.url).query)['channel'][0]
                    can_post=world_allowed if channel=='world' else local_allowed
                    if method=='POST':
                        assert can_post
                        chat_posts.append(body);chat_history[channel].append({'id':str(len(chat_posts)),'text':body['text'],'pet':pet,'createdAt':time.time()});data={'ok':True}
                    else:data={'messages':chat_history[channel],'canRead':channel=='world' or local_allowed,'canPost':can_post,'reason':None if can_post else ('Мир читают все. Для отправки нужно 1 000 000 м².' if channel=='world' else 'Для локального чата нужна своя территория.')}
                elif path=='/api/activity':
                    assert route.request.post_data_json['timezone'];data={'enabled':reminders,'timezone':'Europe/Kaliningrad'}
                elif path=='/api/reminders':reminders=route.request.post_data_json['enabled'];data={'enabled':reminders}
                elif path=='/api/shop':data={'debt':0,'packages':[{'id':str(stars),'stars':stars,'bones':bones} for stars,bones in [(100,10000),(250,30000),(500,80000),(1000,200000)]]}
                elif path=='/api/shop/invoice':data={'url':'https://t.me/$test','orderId':'order'}
                elif path=='/api/shop/orders/order':data={'paid':invoice_paid,'refunded':False}
                elif path.endswith('/largest-territory'):
                    data={'territory':{'id':'largest','area':23456,'geometry':{'type':'Polygon','coordinates':[[[30,60],[30.001,60],[30.001,60.001],[30,60.001],[30,60]]]}} if largest else None}
                elif path=='/api/me':
                    if method=='DELETE':
                        body=route.request.post_data_json;delete_attempts.append(body)
                        assert body['profileId']=='11111111-1111-4111-8111-111111111111' and body['confirmation']=='Луна' and body['confirmed'] is True
                        pet=None;wallet_balance=0
                        if len(delete_attempts)==1:
                            route.fulfill(status=503,content_type='application/json',body='{"detail":"Ответ потерян после удаления"}',headers={'Access-Control-Allow-Origin':'*'});return
                        data={'deleted':True}
                    elif method=='PUT':
                        body=route.request.post_data_json
                        assert body['profileId']==pet['profileId']
                        selected=next(b for b in breed_catalog if b['id']==body['breedId'])
                        pet.update({k:body[k] for k in ['name','age','description','color','hue','saturation','opacity','pattern']})
                        pet.update(breedId=selected['id'],breedName=selected['name'],breedFamily=selected['family'])
                    if method!='DELETE':data={'pet':pet,'area':100 if pet else 0,'canDeletePet':account_role=='primary'}
                elif path=='/api/notifications':data={'unread':0 if notice_read else 1,'notifications':[{'id':'00000000-0000-0000-0000-000000000007','amount':'100','message':'Рекс <img src=x onerror=alert(1)> выкупил вашу территорию, вам выплачены репарации в количестве 100 🦴.','createdAt':time.time(),'read':notice_read}]}
                elif path=='/api/notifications/read':
                    assert route.request.post_data_json['ids']==['00000000-0000-0000-0000-000000000007'];notice_read=True;data={'ok':True}
                elif path=='/api/wallet':data={'balance':wallet_balance,'rate':.5,'incomePeriodSeconds':86400,'nextPayoutAt':time.time()+3600}
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
        assert page.locator('.demo-link,#demo-button,#capture-button').count()==0
        page.evaluate('() => document.fonts.ready')
        assert page.evaluate("""() => document.fonts.check('700 16px "DogWars Comic"','Генерал')""")
        assert page.evaluate("""() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()""")=='#20242b'
        page.screenshot(path='/tmp/dogwars-v111-comic-home.png',full_page=True)
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
        assert page.locator('#wallet-rate').inner_text()=='0,5 🦴/сутки'
        assert 'Следующая выплата:' in page.locator('#wallet-payout').inner_text()
        page.locator('#open-chat').click();page.locator('#chat-text').wait_for(state='visible')
        page.wait_for_function("() => !document.querySelector('#send-chat').disabled")
        assert page.locator('#chat-district').get_attribute('aria-selected')=='true'
        page.locator('#chat-text').fill('<img src=x onerror=alert(1)> Район')
        page.locator('#send-chat').click()
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Район')")
        assert page.locator('#chat-messages img').count()==0 and chat_posts[-1]['channel']=='district'
        page.locator('#chat-text').fill('Районный черновик')
        page.locator('#chat-world').click();page.wait_for_function("() => document.querySelector('#chat-access').textContent.includes('1 000 000')")
        assert page.locator('#chat-text').input_value()==''
        assert page.locator('#chat-world-note').is_visible()
        assert '1 000 000 м²' in page.locator('#chat-world-note').inner_text()
        assert 'гектарами' in page.locator('#chat-world-note').inner_text()
        page.screenshot(path='/tmp/dogwars-v111-comic-world.png')
        assert page.locator('#send-chat').is_disabled() and page.locator('#chat-text').is_disabled()
        assert 'Район' not in page.locator('#chat-messages').inner_text()
        page.locator('#chat-city').click();page.wait_for_function("() => !document.querySelector('#send-chat').disabled")
        assert page.locator('#chat-world-note').is_hidden()
        page.locator('#chat-text').fill('Город');page.locator('#send-chat').click()
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Город')")
        assert chat_posts[-1]['channel']=='city'
        world_allowed=True
        page.locator('#chat-world').click();page.wait_for_function("() => !document.querySelector('#send-chat').disabled")
        page.locator('#chat-text').fill('Мир');page.locator('#send-chat').click()
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Мир')")
        assert chat_posts[-1]['channel']=='world'
        local_allowed=False
        page.locator('#chat-district').click();page.wait_for_function("() => document.querySelector('#chat-access').textContent.includes('нужна своя территория')")
        assert page.locator('#send-chat').is_disabled()
        page.locator('#close-chat').click()
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
        page.locator('#profile-open').click()
        page.locator('#account-settings').wait_for(state='visible')
        page.locator('#account-username').fill('https://t.me/second_general')
        page.locator('#account-invite').click()
        page.locator('#account-share').wait_for(state='visible')
        assert 'link_' in page.locator('#account-invite-url').input_value()
        page.locator('#account-cancel').click()
        page.wait_for_function("() => document.querySelector('#account-state').textContent.includes('пока не привязан')")
        secondary={'id':'88','username':'second_general'}
        page.locator('#close-profile').click();page.locator('#profile-button').click()
        page.locator('#account-remove').wait_for(state='visible')
        page.locator('#account-remove').click()
        page.wait_for_function("() => document.querySelector('#account-state').textContent.includes('пока не привязан')")
        account_role='secondary'
        page.locator('#close-profile').click();page.locator('#profile-button').click()
        page.wait_for_function("() => document.querySelector('#account-primary').hidden")
        assert 'второй аккаунт' in page.locator('#account-state').inner_text()
        account_role='primary'
        page.locator('#close-profile').click();page.locator('#profile-button').click()
        page.locator('#pet-breed').fill('лабрадор')
        page.locator('#breed-results button').first.wait_for()
        assert page.locator('#breed-results .dog-avatar').count()>0
        page.locator('#breed-results button').first.click()
        page.locator('#save-profile').click();page.locator('#profile-dialog').wait_for(state='hidden')
        assert 'лабрадор' in pet['breedName'].lower()
        page.locator('#profile-button').click()
        # Новые узоры отображаются в превью; оттенок меняет базу каждого.
        for pattern,selector in [('digital','rect'),('tiger','path'),('flecktarn','ellipse')]:
            page.locator('#pet-pattern').select_option(pattern)
            assert page.locator(f'#paint-preview pattern {selector}').count()>2
            before=page.locator('#paint-preview > path').get_attribute('fill')
            page.locator('#pet-hue').evaluate("el=>{el.value=220;el.dispatchEvent(new Event('input',{bubbles:true}));}")
            assert page.locator('#paint-preview > path').get_attribute('fill')!=before
            page.locator('#pet-hue').evaluate("el=>{el.value=150;el.dispatchEvent(new Event('input',{bubbles:true}));}")
            page.locator('#paint-preview').screenshot(path=f'/tmp/dogwars-v111-pattern-{pattern}.png')
        page.screenshot(path='/tmp/dogwars-v111-camouflage.png')
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
        assert page.locator('#start-button').count()==0 and page.locator('#live-start').count()==0
        page.locator('#open-hq').click();page.locator('#hq-level').wait_for()
        page.wait_for_function("() => document.querySelector('#hq-percent').textContent==='0%'")
        assert page.locator('#hq-scene .is-animated').count()==1
        page.wait_for_function("() => document.querySelector('.hq-room').naturalWidth>=1500")
        assert page.locator('.hq-room').evaluate('el=>el.tagName')=='IMG'
        assert page.locator('#hq-motion').count()==0
        before_motion=page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).transform')
        page.wait_for_timeout(650)
        after_motion=page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).transform')
        assert before_motion!=after_motion
        page.locator('.hq-pet').dispatch_event('click')
        assert page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).animationName')=='hq-pet-pat'
        page.wait_for_timeout(900)
        assert page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).animationName')=='hq-pet-breathe'

        assert pet['breedName'] in page.locator('#hq-pet-name').inner_text()
        assert page.locator('#hq-profile').count()==0
        assert 'удваивается' not in page.locator('#hq-dialog').inner_text()
        assert page.locator('.hq-landscape').bounding_box()['height']>page.locator('.hq-landscape').bounding_box()['width']
        assert page.locator('#hq-scene .hq-pet').get_attribute('data-breed-sprite')=='labrador'
        assert page.locator('.hq-meter').inner_text().replace('\n','').replace(' ','')=='0%0%100%'
        assert page.evaluate('window.hqFullscreen')
        page.locator('#hq-scene').screenshot(path='/tmp/dogwars-v111-level1.png')
        before_room=page.locator('.hq-room').get_attribute('src')
        page.locator('#hq-upgrade').click()
        page.wait_for_function("() => document.querySelector('#hq-status').textContent.includes('Проверка повтора')")
        page.locator('#hq-upgrade').click()
        page.wait_for_function("() => document.querySelector('#hq-level').textContent.includes('2 / 10')")
        assert hq_attempts[0]==hq_attempts[1] and hq_level==2
        assert page.locator('.hq-room').get_attribute('src')!=before_room
        assert page.locator('#hq-percent').inner_text()=='11%'
        page.screenshot(path='/tmp/dogwars-v111-headquarters.png')
        page.set_viewport_size({'width':844,'height':390})
        page.wait_for_timeout(100)
        page.screenshot(path='/tmp/dogwars-v111-hq-landscape.png')
        dog_box=page.locator('#hq-scene .hq-pet').bounding_box()
        meter_box=page.locator('.hq-meter').bounding_box()
        assert dog_box['y']+dog_box['height']<meter_box['y']+3
        page.set_viewport_size({'width':390,'height':844})
        hq_level=10
        page.locator('#close-hq').click();page.locator('#open-hq').click()
        page.wait_for_function("() => document.querySelector('#hq-percent').textContent==='100%'")
        assert page.locator('#hq-upgrade').is_disabled()
        page.locator('#hq-scene').screenshot(path='/tmp/dogwars-v111-level10.png')
        page.set_viewport_size({'width':320,'height':740})
        page.emulate_media(reduced_motion='reduce')
        assert page.evaluate('() => document.documentElement.scrollWidth<=innerWidth')
        assert page.locator('#hq-scene .hq-pet').evaluate("el=>getComputedStyle(el).animationName")=='hq-pet-breathe-reduced'
        slow_before=page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).transform')
        page.wait_for_timeout(700)
        assert slow_before!=page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).transform')
        page.screenshot(path='/tmp/dogwars-v111-narrow.png')
        page.set_viewport_size({'width':1280,'height':900})
        assert page.evaluate('() => document.documentElement.scrollWidth<=innerWidth')
        page.locator('#close-hq').click()
        page.wait_for_function('() => !document.body.classList.contains("hq-is-open")')
        page.set_viewport_size({'width':390,'height':844})
        gps=page.evaluate('window.gpsCalls');page.locator('#goto-bot').click()
        page.wait_for_function('() => window.closedByTelegram===1')
        assert page.evaluate('window.gpsCalls')==gps
        assert ('POST','/api/walks') not in calls and ('POST','/api/capture') not in calls
        assert ('POST','/api/live/start') not in calls
        now=time.time();live={'id':'live','error':None,'points':[{'latitude':54.71+dy,'longitude':20.45+dx,'accuracy':20,'timestamp':now-27+i*9}
            for i,(dx,dy) in enumerate([(0,0),(.001,0),(.001,.001),(0,0)])]}
        live['trackingByMe']=False
        page.reload(wait_until='networkidle');page.locator('#live-panel').wait_for(state='visible')
        assert page.locator('#live-capture').is_disabled()
        assert 'другого аккаунта' in page.locator('#live-status').inner_text()
        live['trackingByMe']=True
        page.reload(wait_until='networkidle');page.locator('#live-panel').wait_for(state='visible')
        page.locator('#live-capture').click();page.locator('#live-panel').wait_for(state='hidden')
        assert page.locator('#status').inner_text()=='Ай яй яй, захват аннулирован, играй честно'
        page.reload(wait_until='networkidle')
        assert page.locator('#status').inner_text()=='Ай яй яй, захват аннулирован, играй честно'
        assert page.locator('#goto-bot').is_visible()
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
        page.screenshot(path='/tmp/dogwars-v111-mobile.png',full_page=True)
        # Параметр demo больше не открывает профиль/кошелёк без Telegram.
        unsigned=context.new_page()
        unsigned.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"",ready(){},expand(){}}};'))
        unsigned.goto(os.getenv('SMOKE_URL','http://127.0.0.1:8002/docs/')+'?demo=1',wait_until='networkidle')
        assert unsigned.locator('#profile-button').is_disabled()
        assert unsigned.locator('.demo-link,#demo-button').count()==0
        assert 'Telegram' in unsigned.locator('#status').inner_text()
        unsigned.close()
        # Старое сохранённое «off» не отключает новый автоматический режим.
        page.evaluate("localStorage.setItem('dogwars:hq-motion','off')")
        page.reload(wait_until='networkidle');page.locator('#open-hq').click()
        page.locator('.hq-pet').wait_for()
        assert page.locator('.hq-pet').evaluate('el=>getComputedStyle(el).animationName')=='hq-pet-breathe-reduced'
        page.locator('#close-hq').click()
        account_role='secondary';page.reload(wait_until='networkidle');page.locator('#profile-open').click()
        assert page.locator('#delete-pet').is_hidden()
        account_role='primary';page.reload(wait_until='networkidle');page.locator('#profile-open').click()
        page.locator('#delete-pet').click()
        assert page.locator('#confirm-delete-pet').is_disabled()
        page.locator('#delete-pet-name').fill('Не та кличка');page.locator('#delete-pet-ack').check()
        assert page.locator('#confirm-delete-pet').is_disabled()
        page.locator('#delete-pet-name').fill('Луна')
        assert page.locator('#confirm-delete-pet').is_enabled()
        page.locator('#cancel-delete-pet').click();assert pet is not None
        page.locator('#delete-pet').click();page.locator('#delete-pet-name').fill('Луна');page.locator('#delete-pet-ack').check()
        page.screenshot(path='/tmp/dogwars-v111-delete-confirmation.png')
        page.locator('#confirm-delete-pet').click()
        page.wait_for_function("() => document.querySelector('#delete-pet-error').textContent.includes('Ответ потерян')")
        page.locator('#confirm-delete-pet').click()
        page.wait_for_function("() => document.querySelector('#status').textContent.includes('Анкета удалена')")
        assert len(delete_attempts)==2 and delete_attempts[0]==delete_attempts[1]
        assert page.locator('#profile-dialog').is_hidden()
        assert page.locator('#delete-pet').is_hidden()
        assert 'Новую анкету создавать не нужно' in page.locator('#status').inner_text()
        assert not errors,errors
        browser.close();print('v.1.1.1 UI OK: общий аккаунт, полноэкранный горизонтальный штаб, породные иллюстрации, живые маршруты только из Telegram, чат/плашка, суточный доход, камуфляжи, комиксный интерфейс, покупки и уведомления.')


if __name__=='__main__':main()
