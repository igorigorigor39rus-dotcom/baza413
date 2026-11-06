"""Проверка статической сборки под вложенным путём, как на GitHub Pages.

SMOKE_URL=http://127.0.0.1:8002/docs/ BROWSER_PATH=/usr/bin/chromium python tests/pages_smoke.py
Внешние Telegram SDK и тайлы подменяются. Supabase вызываться в демо не должен.
"""
from io import BytesIO
import os

from PIL import Image
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        options={'headless':True}
        if os.getenv('BROWSER_PATH'): options['executable_path']=os.environ['BROWSER_PATH']
        browser=p.chromium.launch(**options)
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        context.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{ready(){},expand(){}}};'))
        image=BytesIO();Image.new('RGB',(256,256),'#e4eadc').save(image,'PNG')
        context.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        supabase_requests=[]
        def unexpected(route):
            supabase_requests.append(route.request.url)
            route.fulfill(status=503,content_type='application/json',body='{}')
        context.route('https://*.supabase.co/**',unexpected)
        page=context.new_page();errors=[];failed=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('response',lambda r:failed.append(r.url) if r.status>=400 and '127.0.0.1' in r.url else None)
        base=os.getenv('SMOKE_URL','http://127.0.0.1:8002/docs/')
        page.goto(base,wait_until='networkidle')
        assert 'через кнопку' in page.locator('#status').inner_text()
        page.locator('.demo-link').click()
        page.locator('#profile-dialog').wait_for(state='visible')
        page.locator('#pet-name').fill('Луна');page.locator('#pet-age').fill('2')
        page.locator('#pet-hue').evaluate("el=>{el.value=210;el.dispatchEvent(new Event('input',{bubbles:true}));}")
        page.locator('#pet-pattern').select_option('camo')
        assert page.locator('#hue-value').inner_text()=='210°'
        page.locator('#pet-description').fill('<script>alert("xss")</script> Любит гулять')
        import random,base64,json
        source=BytesIO();Image.frombytes('RGB',(2048,2048),random.Random(413).randbytes(2048*2048*3)).save(source,'PNG')
        assert len(source.getvalue())>2*1024*1024
        page.locator('#photo-input').set_input_files({'name':'camera.png','mimeType':'image/png','buffer':source.getvalue()})
        page.locator('#save-profile').click();page.locator('#profile-dialog').wait_for(state='hidden')
        stored=page.evaluate("() => JSON.parse(localStorage.getItem('paws:browser-demo:v1')).pet.photo")
        assert len(base64.b64decode(stored.split(',')[1]))<=1000000
        assert page.evaluate("() => getComputedStyle(document.querySelector('.app')).backgroundColor")=='rgb(32, 36, 43)'
        assert page.locator('#map-provider option[value=yandex]').count()==0
        page.locator('#income-rules').click();assert '1 м²' in page.locator('#rules-dialog').inner_text();assert 'Для старых участков' not in ' '.join(page.locator('#rules-dialog').inner_text().split());page.locator('#close-rules').click()
        page.locator('#demo-button').click()
        for _ in range(4): page.locator('#demo-button').click()
        page.locator('#capture-button').click()
        page.wait_for_function('() => document.querySelector("#status").textContent.includes("Территория ваша")')
        assert page.locator('.leaflet-overlay-pane path[fill^="url("]').count()>0
        assert page.locator('pattern image[href*="military-camo.png"]').count()>0
        before=page.locator('.pet-marker[title="Луна"] img').evaluate('el=>el.getBoundingClientRect().width')
        page.locator('.leaflet-control-zoom-out').click()
        page.wait_for_function("size=>document.querySelector('.pet-marker[title=\"Луна\"] img').getBoundingClientRect().width<size",arg=before)
        assert page.locator('.leaflet-overlay-pane path[fill^="url("]').count()>0
        page.locator('.pet-marker[title="Луна"]').click()
        assert '<script>' in page.locator('#owner-description').inner_text()
        assert page.locator('#owner-photo').get_attribute('src').startswith('data:image/jpeg;base64,')
        page.wait_for_function("() => document.querySelector('#owner-bones').textContent.startsWith('🦴 ') && !document.querySelector('#owner-bones').textContent.includes('Загружаем')")
        assert 'недоступ' not in page.locator('#owner-bones').inner_text()
        page.locator('#owner-done').click()
        page.locator('#open-chat').click()
        box=page.locator('#chat-dialog').bounding_box();assert abs(box['width']-390)<2 and abs(box['height']-844)<2
        page.locator('#chat-text').fill('<img src=x onerror=alert(1)> Сообщение агента')
        page.locator('#send-chat').click()
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Сообщение агента')")
        assert page.locator('#chat-messages img').count()==0
        page.locator('#close-chat').click()
        assert '🦴/час' in page.locator('#wallet-rate').inner_text()
        page.locator('#open-top').click();page.locator('#top-body tr').first.wait_for();assert 1<=page.locator('#top-body tr').count()<=10;page.locator('#close-top').click()
        page.reload(wait_until='networkidle')
        assert 'Луна' in page.locator('#walk-title').inner_text()
        assert 'м² ваших' in page.locator('#area-label').inner_text()
        assert not supabase_requests,supabase_requests
        assert not errors,errors
        assert not failed,failed
        assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path='/tmp/baza413-pages-mobile.png',full_page=True)
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path='/tmp/baza413-pages-desktop.png',full_page=True)
        # Выпуск фронтенда до обновления сервера не ломает существующий профиль.
        legacy=browser.new_context(viewport={'width':390,'height':844})
        legacy.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"test-signed",ready(){},expand(){}}};'))
        legacy.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        payloads=[]
        def old_api(route):
            import json
            path=route.request.url.split('/paws-api')[-1].split('?')[0]
            if path=='/api/config': data={'demoMode':False}
            elif path=='/api/me':
                if route.request.method=='PUT':
                    body=route.request.post_data_json;payloads.append(body);assert 'hue' not in body
                data={'pet':{'id':'42','name':'Ричи','age':3,'description':'','color':'#397C63'},'area':100}
            elif path=='/api/territories':data={'territories':[],'pets':{},'truncated':False}
            else:route.fulfill(status=404,content_type='application/json',body='{"detail":"Update required"}');return
            route.fulfill(content_type='application/json',body=json.dumps(data),headers={'Access-Control-Allow-Origin':'*'})
        legacy.route('https://*.supabase.co/**',old_api)
        old=legacy.new_page();old.goto(base,wait_until='networkidle');old.locator('#profile-button').click()
        assert old.locator('#pet-hue').is_enabled()
        assert old.locator('#server-notice').is_visible()
        old.locator('#save-profile').click();old.locator('#profile-dialog').wait_for(state='hidden');assert payloads
        legacy.close()
        # Полный контракт обновлённого API: стили сохраняются, POST чата
        # отправляет текст, чужие 🦴 берутся из свежей карточки.
        modern=browser.new_context(viewport={'width':390,'height':844})
        modern.route('https://telegram.org/**',lambda r:r.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{initData:"test-signed",ready(){},expand(){}}};'))
        modern.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        modern.route('https://*.tile.opentopomap.org/**',lambda r:r.fulfill(content_type='image/png',body=image.getvalue()))
        pet={'id':'42','name':'Агент','age':3,'description':'Досье','color':'#397C63','hue':150,'saturation':55,'opacity':.35,'pattern':'solid'}
        neighbor={'id':'99','name':'Бублик','age':2,'color':'#808080','description':'Досье соседа','wallet':{'balance':9876.75,'rate':100}}
        chat=[]
        def new_api(route):
            import json,time
            path=route.request.url.split('/paws-api')[-1].split('?')[0]
            if path=='/api/config':data={'version':'0.4.0','demoMode':False,'features':{'dossier':True,'chat':True,'wallet':True,'publicWallet':True}}
            elif path=='/api/me':
                if route.request.method=='PUT':pet.update(route.request.post_data_json)
                data={'pet':pet,'area':100}
            elif path=='/api/wallet':data={'balance':42,'rate':100}
            elif path=='/api/pets/99':data=neighbor
            elif path=='/api/territories':data={'territories':[{'id':'land','ownerId':'99','geometry':{'type':'Polygon','coordinates':[[[20.452,54.7105],[20.453,54.7105],[20.453,54.711],[20.452,54.711],[20.452,54.7105]]]},'marker':[54.7108,20.4525]}],'pets':{'99':neighbor},'truncated':False}
            elif path=='/api/chat':
                if route.request.method=='POST':chat.append({'id':'1','text':route.request.post_data_json['text'],'pet':pet,'createdAt':time.time()})
                data={'ok':True} if route.request.method=='POST' else {'messages':chat}
            else:raise AssertionError('Unexpected API '+path)
            route.fulfill(content_type='application/json',body=json.dumps(data),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'})
        modern.route('https://*.supabase.co/**',new_api)
        active=modern.new_page();active.goto(base,wait_until='networkidle')
        assert active.locator('#server-notice').is_hidden()
        active.locator('#profile-button').click()
        for field in ['pet-hue','pet-saturation','pet-opacity','pet-pattern']:assert active.locator('#'+field).is_enabled()
        active.locator('#pet-hue').evaluate("el=>{el.value=230;el.dispatchEvent(new Event('input',{bubbles:true}));}")
        active.locator('#pet-pattern').select_option('grid');active.locator('#save-profile').click();active.locator('#profile-dialog').wait_for(state='hidden')
        assert pet['hue']==230 and pet['pattern']=='grid'
        active.locator('.pet-marker[title="Бублик"]').click()
        active.wait_for_function("() => document.querySelector('#owner-bones').textContent.includes('876')")
        assert ''.join(active.locator('#owner-bones').inner_text().split())=='🦴9876'
        active.locator('#owner-done').click();active.locator('#open-chat').click()
        active.locator('#chat-text').fill('Проверка v.0.4');active.locator('#send-chat').click()
        active.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Проверка v.0.4')")
        assert chat[0]['text']=='Проверка v.0.4'
        active.locator('#close-chat').click();active.locator('#map-provider').select_option('relief')
        active.wait_for_function("() => document.querySelector('.leaflet-control-attribution').textContent.includes('OpenTopoMap')")
        modern.close()
        browser.close()
        print('Досье/Hue/камуфляж/чат/косточки OK. Pages OK: вложенный путь, демо без Supabase, PNG → JPEG, перезахват, карточка, безопасный текст, reload, mobile/desktop.')


if __name__=='__main__': main()
