"""Проверка подписи Telegram. Нельзя доверять user.id, присланному самим браузером."""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

from fastapi import HTTPException


def verify_init_data(raw: str, bot_token: str, now: float | None = None) -> int:
    now = time.time() if now is None else now
    try:
        if not raw or len(raw) > 8192 or not bot_token:
            raise ValueError('missing credentials')
        pairs = parse_qsl(raw, strict_parsing=True)
        fields = dict(pairs)
        if len(fields) != len(pairs):
            raise ValueError('duplicate fields')
        supplied = fields.pop('hash')
        check_string = '\n'.join(f'{key}={value}' for key, value in sorted(fields.items()))
        secret = hmac.new(b'WebAppData', bot_token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied):
            raise ValueError('invalid signature')
        age = now - int(fields['auth_date'])
        if age < -30 or age > 3600:
            raise ValueError('expired')
        user = json.loads(fields['user'])
        user_id = user['id']
        if type(user_id) is not int or not 0 < user_id < 2 ** 52:
            raise ValueError('invalid user')
        return user_id
    except (ValueError, KeyError, TypeError, OverflowError):
        raise HTTPException(401, 'Откройте приложение заново через кнопку Telegram-бота.') from None
