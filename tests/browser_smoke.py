"""Ручной запуск после старта DEMO_MODE=true сервера: python tests/browser_smoke.py.

Тест использует настоящий Chromium, но подменяет только Telegram SDK и тайлы.
Он НЕ подтверждает соединение с Telegram/OSM и GPS настоящего телефона.
Опционально задайте BROWSER_PATH для установленного Chromium.
"""
from base64 import b64decode
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as playwright:
        executable = os.getenv('BROWSER_PATH')
        browser = playwright.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
        context = browser.new_context(viewport={'width':390,'height':844}, device_scale_factor=1, is_mobile=True, has_touch=True)
        # Подпись Telegram отдельно проверяется интеграционными тестами Python.
        context.route('https://telegram.org/**', lambda route: route.fulfill(content_type='text/javascript',body='window.Telegram={WebApp:{ready(){},expand(){}}};'))
        tile = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
        context.route('https://tile.openstreetmap.org/**',lambda route: route.fulfill(content_type='image/png',body=tile))
        page=context.new_page();errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(os.getenv('SMOKE_URL','http://127.0.0.1:8000/?backend=python'),wait_until='networkidle')
        assert page.locator('#mode-banner').is_visible()
        if not page.locator('#profile-dialog').is_visible(): page.locator('#profile-button').click()
        page.locator('#pet-name').fill('Ричи')
        page.locator('#pet-age').fill('3')
        page.locator('#pet-description').fill('Тестируем прогулку через Telegram Mini App')
        page.locator('#save-profile').click()
        page.locator('#profile-dialog').wait_for(state='hidden')
        page.locator('#demo-button').click()
        for _ in range(4): page.locator('#demo-button').click()
        assert page.locator('#capture-button').is_enabled()
        with page.expect_response('**/api/demo/capture') as response: page.locator('#capture-button').click()
        assert response.value.status==200
        page.wait_for_function('() => document.querySelector("#status").textContent.includes("Территория ваша")')
        page.locator('.pet-marker').first.click()
        assert page.locator('#owner-dialog').is_visible()
        page.locator('#owner-done').click()
        page.reload(wait_until='networkidle')
        assert 'Ричи' in page.locator('#walk-title').inner_text()
        assert 'м² ваших открытий' in page.locator('#area-label').inner_text()
        assert page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        page.screenshot(path='/tmp/baza413-telegram-mobile.png',full_page=True)
        page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path='/tmp/baza413-telegram-desktop.png',full_page=True)
        # Дополнительно проходим настоящий браузерный Geolocation API, но с
        # подставленными координатами Chromium (это не физический GPS).
        context.grant_permissions(['geolocation'])
        context.set_geolocation({'latitude':54.7100,'longitude':20.4510,'accuracy':3})
        page.locator('#start-button').click()
        page.locator('#capture-button').wait_for(state='visible')
        for latitude,longitude in [(54.7100,20.4512),(54.7102,20.4512),(54.7102,20.4510),(54.7100,20.4510)]:
            page.wait_for_timeout(1100)  # правдоподобные времена GPS для проверки скорости сервером
            context.set_geolocation({'latitude':latitude,'longitude':longitude,'accuracy':3})
        page.wait_for_function('() => !document.querySelector("#capture-button").disabled')
        with page.expect_response('**/api/capture') as gps_response: page.locator('#capture-button').click()
        assert gps_response.value.status==200,gps_response.value.text()
        page.locator('#start-button').wait_for(state='visible')
        page.locator('#start-button').click()
        page.locator('#capture-button').wait_for(state='visible')
        with page.expect_response(lambda r: '/api/walks/' in r.url and r.request.method=='DELETE'):
            page.evaluate('() => { Object.defineProperty(document,"hidden",{get:()=>true,configurable:true}); document.dispatchEvent(new Event("visibilitychange")); }')
        assert page.locator('#capture-button').is_hidden()
        assert 'ушло в фон' in page.locator('#status').inner_text()
        assert not errors,errors
        browser.close()
        print('Browser OK: профиль → демопрогулка → перезахват → карточка → reload; mobile/desktop; Geolocation API → захват → отмена при уходе в фон. Внешние сервисы/GPS подменены.')


if __name__=='__main__': main()
