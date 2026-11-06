"""Однократная настройка бота. Python нужен только для этой команды, не как сервер.

Токен и секрет вводятся через getpass (без отображения), не сохраняются на диск
и не печатаются. Выполняет getMe, проверку API, setWebhook, команды и меню.
"""
from getpass import getpass
import hashlib
import hmac
import json
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PROJECT_URL = 'https://fywsqxijebneqkxusgro.supabase.co'
APP_URL = 'https://igorigorigor39rus-dotcom.github.io/baza413/'


def request(url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    try:
        req = Request(url, data=data, headers={**({'Content-Type':'application/json'} if data else {}), **(headers or {})})
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}. Проверьте установку функции и настройки. Секреты не выведены.') from None
    except (URLError, ValueError):
        raise RuntimeError('Нет подключения к сервису или неожиданный ответ. Проверьте интернет.') from None


def init_data(token, user_id):
    fields = {'auth_date':str(int(time.time())), 'user':json.dumps({'id':user_id})}
    secret = hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
    fields['hash'] = hmac.new(secret,'\n'.join(f'{k}={v}' for k,v in sorted(fields.items())).encode(),hashlib.sha256).hexdigest()
    return urlencode(fields)


def main():
    print('Сначала установите миграцию, Edge Function и секреты в Supabase по README.')
    try:
        with urlopen(APP_URL+'config.mjs',timeout=30) as response:
            if PROJECT_URL not in response.read().decode():
                raise RuntimeError('GitHub Pages содержит другую версию конфигурации. Обновите docs/.')
    except (HTTPError,URLError):
        raise RuntimeError('GitHub Pages ещё не доступен. Включите prototype /docs в Settings → Pages и дождитесь публикации.') from None
    token = getpass('Действующий токен бота из BotFather (не отображается): ').strip()
    secret = getpass('WEBHOOK_SECRET, который вы сохранили в Supabase (не отображается): ').strip()
    if not token or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',secret):
        raise RuntimeError('Укажите токен и WEBHOOK_SECRET из 32–256 букв, цифр, _ или -.')
    api = f'{PROJECT_URL}/functions/v1/paws-api'
    if not request(api+'/health').get('ok'):
        raise RuntimeError('Supabase ещё не готов.')
    config=request(api+'/api/config')
    if not all(config.get('features',{}).get(key) for key in ('autoLiveStart','starShop','reminders','largestTerritory')):
        raise RuntimeError('Сначала установите SQL и Edge Function v.0.8; нужны функции магазина, напоминаний и территорий.')
    if config.get('appUrl') != APP_URL:
        raise RuntimeError('В APP_URL в Supabase должен быть адрес из README, включая /baza413/ в конце.')
    # Пустой update проверяет секрет, но не отправляет сообщений.
    request(api+'/webhook',{},headers={'X-Telegram-Bot-Api-Secret-Token':secret})
    def bot(method, payload=None):
        result=request(f'https://api.telegram.org/bot{token}/{method}', payload or {})
        if not result.get('ok'): raise RuntimeError('Telegram отклонил настройку. Проверьте нового бота и токен.')
        return result['result']
    info = bot('getMe')
    # Проверяем совпадение локального токена и секрета Edge, не создавая профиль.
    request(api+'/api/me',headers={'Authorization':'tma '+init_data(token,info['id'])})
    result = bot('setWebhook',{'url':api+'/webhook','secret_token':secret,'allowed_updates':['message','edited_message','callback_query','pre_checkout_query'],'drop_pending_updates':False})
    if not result: raise RuntimeError('Webhook не установлен.')
    bot('setMyCommands',{'commands':[{'command':'start','description':'Открыть карту и профиль питомца'},{'command':'help','description':'Как играть'},{'command':'privacy','description':'О данных'},{'command':'status','description':'Фоновая прогулка: состояние'},{'command':'capture','description':'Захватить фоновый маршрут'},{'command':'cancel','description':'Отменить фоновую прогулку'},{'command':'shop','description':'Купить косточки за Telegram Stars'},{'command':'paysupport','description':'Помощь по оплате'},{'command':'reminders_on','description':'Включить напоминания'},{'command':'reminders_off','description':'Отключить напоминания'}]})
    bot('setChatMenuButton',{'menu_button':{'type':'web_app','text':'Карта','web_app':{'url':APP_URL}}})
    print(f'Готово. Откройте @{info["username"]} и отправьте /start.')
    print('Компьютер теперь можно выключить: запросы обслуживает Supabase.')


if __name__ == '__main__':
    try: main()
    except (RuntimeError, KeyboardInterrupt) as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Настройка отменена.')
        raise SystemExit(1)
