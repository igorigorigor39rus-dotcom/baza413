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
        page.locator('#pet-description').fill('<script>alert("xss")</script> Любит гулять')
        page.locator('#photo-input').set_input_files({'name':'pet.png','mimeType':'image/png','buffer':image.getvalue()})
        page.locator('#save-profile').click();page.locator('#profile-dialog').wait_for(state='hidden')
        page.locator('#demo-button').click()
        for _ in range(4): page.locator('#demo-button').click()
        page.locator('#capture-button').click()
        page.wait_for_function('() => document.querySelector("#status").textContent.includes("Территория ваша")')
        page.locator('.pet-marker[title="Луна"]').click()
        assert '<script>' in page.locator('#owner-description').inner_text()
        assert page.locator('#owner-photo').get_attribute('src').startswith('data:image/jpeg;base64,')
        page.locator('#owner-done').click()
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
        browser.close()
        print('Pages OK: вложенный путь, демо без Supabase, PNG → JPEG, перезахват, карточка, безопасный текст, reload, mobile/desktop.')


if __name__=='__main__': main()
