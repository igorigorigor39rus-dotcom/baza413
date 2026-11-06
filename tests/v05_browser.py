"""Контракт UI фоновой прогулки. Только локальный сервер и подмена API/GPS.

BROWSER_PATH=/usr/bin/chromium .venv/bin/python tests/v05_browser.py
Физическую фоновую геолокацию Telegram проверяет владелец на телефоне.
"""
import json
import os
import time
from io import BytesIO

from PIL import Image
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.getenv('BROWSER_PATH', '/usr/bin/chromium'))
        context = browser.new_context(viewport={'width': 390, 'height': 844}, permissions=['geolocation'],
                                      geolocation={'latitude': 54.71, 'longitude': 20.45, 'accuracy': 16})
        context.route('https://telegram.org/**', lambda r: r.fulfill(content_type='text/javascript', body='window.Telegram={WebApp:{initData:"test-signed",ready(){},expand(){},close(){}}};'))
        image = BytesIO(); Image.new('RGB', (256, 256), '#333').save(image, 'PNG')
        context.route('https://tile.openstreetmap.org/**', lambda r: r.fulfill(content_type='image/png', body=image.getvalue()))
        pet = {'id': '42', 'name': 'Луна', 'age': 2, 'description': '', 'color': '#397C63'}
        live = None
        calls = []

        def api(route):
            nonlocal live
            path = route.request.url.split('/paws-api')[-1].split('?')[0]
            if route.request.method == 'OPTIONS':
                data = {}
            else:
                calls.append((route.request.method, path, route.request.post_data))
                if path == '/api/config':
                    data = {'version': '0.5.0', 'closureMeters': 15, 'demoMode': False, 'features': {
                        'dossier': True, 'chat': True, 'wallet': True, 'publicWallet': True, 'liveTracking': True, 'leaderboard': True}}
                elif path == '/api/me': data = {'pet': pet, 'area': 100}
                elif path == '/api/wallet': data = {'balance': 10, 'rate': 100}
                elif path == '/api/territories': data = {'territories': [], 'pets': {}, 'truncated': False}
                elif path == '/api/live/start':
                    assert route.request.post_data_json == {'accuracy': 15}
                    live = {'id': 'walk-test', 'points': [], 'error': None}
                    data = {'walk': live}
                elif path == '/api/live/status': data = {'walk': live}
                elif path == '/api/live/capture':
                    # Клиент не может подставлять свой маршрут в серверный буфер.
                    assert not route.request.post_data
                    live = None
                    data = {'area': 100, 'id': 'captured'}
                elif path == '/api/chat': data = {'messages': []}
                elif path == '/api/top':
                    data = {'agents': [{'pet': {**pet, 'id': str(i), 'name': f'Агент {i}'}, 'wallet': {'balance': 100-i}} for i in range(1, 11)]}
                else: raise AssertionError('Неожиданный запрос: ' + path)
            route.fulfill(content_type='application/json', body=json.dumps(data), headers={
                'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'})

        context.route('https://*.supabase.co/**', api)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        base = os.getenv('SMOKE_URL', 'http://127.0.0.1:8002/docs/')
        page.goto(base, wait_until='networkidle')
        assert '15 м' in page.locator('#closure-hint').inner_text()
        page.locator('#live-start').click()
        page.wait_for_function("() => document.querySelector('#status').textContent.includes('≤15')")
        assert not any(path == '/api/live/start' for _, path, _ in calls)
        context.set_geolocation({'latitude': 54.71, 'longitude': 20.45, 'accuracy': 15})
        page.locator('#live-start').click(); page.locator('#live-panel').wait_for(state='visible')
        assert page.locator('#start-button').is_hidden()
        assert page.locator('#live-capture').is_disabled()
        page.evaluate("() => {Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'));}")
        # Уход Mini App в фон не отменяет отдельную серверную прогулку.
        assert live is not None
        assert not any(method == 'DELETE' or path == '/api/live/cancel' for method, path, _ in calls)
        now = time.time()
        live['points'] = [{'latitude': 54.71+dy, 'longitude': 20.45+dx, 'accuracy': 15, 'timestamp': now-60+i*20}
                          for i, (dx, dy) in enumerate([(0, 0), (.001, 0), (.001, .001), (0, 0)])]
        page.reload(wait_until='networkidle'); page.locator('#live-panel').wait_for(state='visible')
        assert 'Принято точек: 4' in page.locator('#live-status').inner_text()
        assert page.locator('#live-capture').is_enabled()
        page.locator('#open-chat').click()
        box = page.locator('#chat-dialog').bounding_box()
        assert abs(box['width']-390) < 2 and abs(box['height']-844) < 2
        page.locator('#close-chat').click()
        page.locator('#live-capture').click(); page.locator('#live-panel').wait_for(state='hidden')
        assert page.locator('#start-button').is_visible()
        page.locator('#open-top').click(); page.locator('#top-body tr').first.wait_for()
        assert page.locator('#top-body tr').count() == 10
        assert 'Агент 1' in page.locator('#top-body tr').first.inner_text()
        assert not errors, errors
        browser.close()
        print('v.0.5 UI OK: GPS ≤15, фон без отмены, восстановление, захват, полный экран чата, ТОП-10.')


if __name__ == '__main__': main()
