"""Настройка ОТДЕЛЬНОГО бота. Стандартная библиотека Python, без pip.

--init создаёт локальный файл секретов; обычный запуск регистрирует webhook.
Токен и webhook_secret никогда не выводятся в терминал.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.env.feedback'
PROJECT = 'fywsqxijebneqkxusgro'
COMMANDS = [
    {'command': 'start', 'description': 'Меню обратной связи'},
    {'command': 'my', 'description': 'Мои обращения'},
    {'command': 'support', 'description': 'Поддержать разработчика'},
    {'command': 'cancel', 'description': 'Отмена ввода'},
    {'command': 'paysupport', 'description': 'Вопросы об оплате и возврате'},
    {'command': 'terms', 'description': 'Условия поддержки'},
    {'command': 'privacy', 'description': 'Обработка данных'},
    {'command': 'id', 'description': 'Мой ID и ID чата'},
]


def request_json(url, body=None, headers=None):
    request = urllib.request.Request(
        url, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}. Проверьте функцию, миграцию и секреты. Секреты не выведены.') from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError('Нет ответа сервера. Проверьте интернет. Секреты не выведены.') from None


def telegram(token, method, data):
    result = request_json(f'https://api.telegram.org/bot{token}/{method}', data)
    if result.get('ok') is not True:
        raise RuntimeError('Telegram отклонил запрос. Проверьте настройки отдельного бота.')
    return result['result']


def read_env(path):
    result = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip()
    return result


def validate(values):
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', values.get('FEEDBACK_BOT_TOKEN', '')):
        raise RuntimeError('Некорректный токен отдельного бота.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', values.get('FEEDBACK_WEBHOOK_SECRET', '')):
        raise RuntimeError('WEBHOOK_SECRET должен содержать 32–256 символов: буквы, цифры, _ или -.')
    ids = values.get('FEEDBACK_ADMIN_IDS', '')
    group = values.get('FEEDBACK_ADMIN_CHAT_ID', '')
    if ids and not re.fullmatch(r'[1-9][0-9]*(,[1-9][0-9]*)*', ids):
        raise RuntimeError('ADMIN_IDS: положительные ID через запятую, без пробелов.')
    if group and not re.fullmatch(r'-[1-9][0-9]*', group):
        raise RuntimeError('ADMIN_CHAT_ID должен быть отрицательным ID Telegram-группы.')


def initialize():
    if ENV.exists():
        raise RuntimeError('Файл .env.feedback уже существует. Отредактируйте его; секрет автоматически не заменён.')
    token = getpass.getpass('Токен ОТДЕЛЬНОГО бота из BotFather (скрыт): ').strip()
    secret = secrets.token_urlsafe(48)
    values = {'FEEDBACK_BOT_TOKEN': token, 'FEEDBACK_WEBHOOK_SECRET': secret,
              'FEEDBACK_ADMIN_IDS': '', 'FEEDBACK_ADMIN_CHAT_ID': ''}
    validate(values)
    me = telegram(token, 'getMe', {})
    print(f'Выбран бот @{me["username"]}. Убедитесь, что это НЕ игровой бот DogWars.')
    if input('Это отдельный бот обратной связи? Введите ДА: ').strip().lower() not in ('да', 'yes'):
        raise RuntimeError('Настройка отменена, файл не создан.')
    # O_EXCL запрещает случайно перезаписать имеющийся файл с ключами.
    descriptor = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write('# Только для Supabase Secrets. Не публиковать и не пересылать.\n')
        for key, value in values.items():
            stream.write(f'{key}={value}\n')
    print('Создан .env.feedback. WEBHOOK_SECRET сгенерирован и сохранён в нём.')
    print('Загрузите секреты и функцию по README, затем запустите этот скрипт без --init.')


def register(project):
    if not ENV.exists():
        raise RuntimeError('Сначала запустите этот скрипт с --init.')
    values = read_env(ENV)
    validate(values)
    if not re.fullmatch(r'[a-z0-9]{20}', project):
        raise RuntimeError('Некорректный project-ref Supabase.')
    token = values['FEEDBACK_BOT_TOKEN']
    target = f'https://{project}.supabase.co/functions/v1/dogwars-feedback'
    health = request_json(f'{target}/health')
    if health.get('service') != 'dogwars-feedback' or not health.get('configured'):
        raise RuntimeError('Функция не готова. Установите SQL, секреты и функцию по README.')
    # Защита от случайной замены webhook основного игрового бота.
    current = telegram(token, 'getWebhookInfo', {})
    if current.get('url') and current['url'] != target:
        raise RuntimeError('У этого бота уже другой webhook. Он не изменён. Проверьте, что выбрали отдельного бота обратной связи.')
    me = telegram(token, 'getMe', {})
    # Проверяем совпадение локального секрета с развернутым до регистрации webhook.
    request_json(f'{target}/retry', {}, {'X-Telegram-Bot-Api-Secret-Token': values['FEEDBACK_WEBHOOK_SECRET']})
    telegram(token, 'setWebhook', {
        'url': target, 'secret_token': values['FEEDBACK_WEBHOOK_SECRET'],
        'allowed_updates': ['message', 'callback_query', 'pre_checkout_query'],
        'drop_pending_updates': False,
    })
    telegram(token, 'setMyCommands', {'commands': COMMANDS, 'scope': {'type': 'all_private_chats'}})
    print(f'Готово: https://t.me/{me["username"]}')
    print(f'Webhook: {target}')
    if not health.get('admins_configured') or not health.get('group_configured'):
        print('Остался шаг /id: заполните ADMIN_IDS и ADMIN_CHAT_ID в .env.feedback и повторно загрузите секреты.')
    else:
        print('Группа и администраторы настроены. Проведите проверку по README.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--init', action='store_true')
    parser.add_argument('--project-ref', default=PROJECT)
    args = parser.parse_args()
    try:
        initialize() if args.init else register(args.project_ref)
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        # Не печатаем сетевой traceback, который мог бы содержать URL с токеном.
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        else:
            print('Ошибка чтения настроек или ответа сервера. Секреты не выведены.', file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print('\nОтменено.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
