"""Бот — входная дверь: /start показывает кнопку, карта открывается в Mini App.

Запускается отдельным процессом: python -m backend.bot. Сама карта работает
через HTTP-сервер backend.app, а не внутри обработчика сообщений.
"""
import asyncio
import os
from urllib.parse import urlsplit

import httpx

from .config import Settings


class BotError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f'Telegram Bot API: код {code}')  # URL с токеном не печатаем


def validate_app_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('APP_URL должен быть публичным HTTPS-адресом Mini App без логина и пароля.')
    return url


class Bot:
    def __init__(self, token, app_url, client):
        self.base = f'https://api.telegram.org/bot{token}'
        self.app_url, self.client = validate_app_url(app_url), client

    async def call(self, method, **payload):
        try:
            response = await self.client.post(f'{self.base}/{method}', json=payload)
            body = response.json()
            if not body.get('ok'):
                raise BotError(body.get('error_code', response.status_code))
            return body['result']
        except (httpx.HTTPError, ValueError):
            raise BotError('network') from None

    async def handle(self, update):
        message = update.get('message')
        if not message or not message.get('text', '').strip() or message.get('from', {}).get('is_bot'):
            return
        chat = message['chat']
        command = message['text'].split()[0].split('@')[0]
        if chat['type'] != 'private':
            return  # профили и геолокацию обсуждаем только в личном чате
        if command == '/privacy':
            return await self.call('sendMessage', chat_id=chat['id'], text=(
                'Сохраняются Telegram ID, профиль питомца, фото и захваченные территории. '
                'Профиль и территории видны другим участникам. Полный GPS-маршрут обрабатывается при захвате, '
                'но не сохраняется в базе. Контур захваченного участка сохраняется. '
                'Это игровой прототип; не указывайте домашний адрес и личные данные в описании питомца.'))
        await self.call('sendMessage', chat_id=chat['id'], text=(
            '🐾 Лапы на карте\n\nСоздайте профиль питомца, обойдите участок и замкните маршрут — '
            'территория станет вашей! Карту и GPS откроет кнопка ниже. '
            'Во время прогулки оставляйте мини-приложение открытым.\n\n'
            '/privacy — какие данные сохраняются.'),
            reply_markup={'inline_keyboard': [[{'text': '🐾 Открыть карту', 'web_app': {'url': self.app_url}}]]})


async def main():
    settings = Settings.from_env()
    if not settings.bot_token:
        raise SystemExit('Добавьте TELEGRAM_BOT_TOKEN в локальный .env. Не присылайте токен в чат.')
    if settings.demo_mode:
        raise SystemExit('Для Telegram установите DEMO_MODE=false. Демонстрация предназначена для локального браузера.')
    try:
        url = validate_app_url(os.getenv('APP_URL', ''))
    except ValueError as error:
        raise SystemExit(str(error)) from None
    async with httpx.AsyncClient(timeout=httpx.Timeout(40, connect=10)) as client:
        bot = Bot(settings.bot_token, url, client)
        try:
            await bot.call('getMe')
            await bot.call('setMyCommands', commands=[
                {'command': 'start', 'description': 'Открыть карту и профиль питомца'},
                {'command': 'help', 'description': 'Как играть'},
                {'command': 'privacy', 'description': 'О данных и приватности'},
            ])
            await bot.call('setChatMenuButton', menu_button={
                'type': 'web_app', 'text': 'Карта', 'web_app': {'url': url}})
        except BotError as error:
            raise SystemExit(f'Не удалось настроить бота: код {error.code}. Проверьте токен и доступ к api.telegram.org.') from None
        print('Бот запущен. Откройте его личный чат и отправьте /start.', flush=True)
        offset = 0
        while True:
            try:
                updates = await bot.call('getUpdates', offset=offset, timeout=25, allowed_updates=['message'])
                for update in updates:
                    await bot.handle(update)
                    offset = update['update_id'] + 1
            except BotError as error:
                if error.code in (401, 403, 409):
                    raise SystemExit(f'Бот остановлен: код {error.code}. При 409 проверьте другой процесс бота или активный webhook.') from None
                print('Telegram временно недоступен. Повтор через 5 секунд.', flush=True)
                await asyncio.sleep(5)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('Бот остановлен.')
