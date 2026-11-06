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
        page.locator('#photo-input').set_input_files({'name':'pet.png','mimeType':'image/png','buffer':image.getvalue()})
        page.locator('#save-profile').click();page.locator('#profile-dialog').wait_for(state='hidden')
        page.locator('#demo-button').click()
        for _ in range(4): page.locator('#demo-button').click()
        page.locator('#capture-button').click()
        page.wait_for_function('() => document.querySelector("#status").textContent.includes("Территория ваша")')
        assert page.locator('.leaflet-overlay-pane path[fill^="url("]').count()>0
        page.locator('.pet-marker[title="Луна"]').click()
        assert '<script>' in page.locator('#owner-description').inner_text()
        assert page.locator('#owner-photo').get_attribute('src').startswith('data:image/jpeg;base64,')
        page.locator('#owner-done').click()
        page.locator('#open-chat').click()
        page.locator('#chat-text').fill('<img src=x onerror=alert(1)> Сообщение агента')
        page.locator('#send-chat').click()
        page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('Сообщение агента')")
        assert page.locator('#chat-messages img').count()==0
        page.locator('#close-chat').click()
        assert 'косточек/час' in page.locator('#wallet-rate').inner_text()
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
        assert old.locator('#pet-hue').is_disabled()
        old.locator('#save-profile').click();old.locator('#profile-dialog').wait_for(state='hidden');assert payloads
        legacy.close()
        browser.close()
        print('Досье/Hue/камуфляж/чат/косточки OK. Pages OK: вложенный путь, демо без Supabase, PNG → JPEG, перезахват, карточка, безопасный текст, reload, mobile/desktop.')


if __name__=='__main__': main()
