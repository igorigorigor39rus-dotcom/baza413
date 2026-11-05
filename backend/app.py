"""HTTP API и статические файлы Mini App. Запуск: python -m uvicorn backend.app:app."""
from contextlib import asynccontextmanager
from io import BytesIO
import json
from pathlib import Path
import time
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field
from shapely.geometry import shape

from .auth import verify_init_data
from .config import ROOT, Settings
from .database import connect, initialize, insert_territory, public_pet, public_territory
from .geometry import square_meters, subtract, validate_route
from .demo import ROUTE


class PetInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra='forbid')
    name: str = Field(min_length=1, max_length=40)
    age: float = Field(ge=0, le=35, allow_inf_nan=False)
    description: str = Field(default='', max_length=400)
    color: str = Field(pattern=r'^#[0-9a-fA-F]{6}$')


class Sample(BaseModel):
    model_config = ConfigDict(extra='forbid')
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(ge=-85, le=85, allow_inf_nan=False)
    accuracy: float = Field(ge=0, le=15, allow_inf_nan=False)
    timestamp: float = Field(allow_inf_nan=False)  # секунды Unix, как time.time() в Python


class CaptureInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    walk_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    points: list[Sample] = Field(min_length=4, max_length=5000)


class BodyLimitMiddleware:
    """Ограничиваем весь HTTP-body до разбора JSON/фото, в том числе chunked-запросы."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in ('POST', 'PUT', 'PATCH'):
            return await self.app(scope, receive, send)
        chunks, total = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            total += len(message.get('body', b''))
            if total > 3 * 1024 * 1024:
                return await JSONResponse({'detail': 'Запрос слишком большой. Фото должно быть не больше 2 МБ.'}, 413)(scope, receive, send)
            chunks.append(message.get('body', b''))
            if not message.get('more_body'):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        if not settings.demo_mode and not settings.bot_token:
            raise RuntimeError('Задайте TELEGRAM_BOT_TOKEN или включите DEMO_MODE=true для локальной демонстрации.')
        initialize(settings.database, settings.demo_mode)
        settings.photos.mkdir(parents=True, exist_ok=True)
        yield

    app = FastAPI(title='Лапы на карте', lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(BodyLimitMiddleware)

    @app.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self' https://telegram.org; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; "
            "connect-src 'self'; frame-ancestors 'self' https://*.telegram.org https://telegram.org; "
            "base-uri 'none'; form-action 'self'; object-src 'none'"
        )
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def authenticated(authorization: str = Header(default='')):
        if settings.demo_mode:
            return 1
        if not authorization.startswith('tma '):
            raise HTTPException(401, 'Откройте приложение через кнопку Telegram-бота.')
        return verify_init_data(authorization[4:], settings.bot_token)

    @app.get('/health')
    def health():
        with connect(settings.database) as db:
            db.execute('SELECT 1').fetchone()
        return {'ok': True}

    @app.get('/api/config')
    def config():
        return {'demoMode': settings.demo_mode, 'closureMeters': 5, 'maxAccuracy': 15,
                'demoRoute': ROUTE if settings.demo_mode else None}

    @app.get('/api/me')
    def me(user=Depends(authenticated)):
        with connect(settings.database) as db:
            row = db.execute('SELECT * FROM pets WHERE owner_id = ?', (user,)).fetchone()
            area = db.execute('SELECT COALESCE(SUM(area), 0) FROM territories WHERE owner_id = ?', (user,)).fetchone()[0]
            return {'pet': public_pet(row) if row else None, 'area': area}

    @app.put('/api/me')
    def save_pet(pet: PetInput, user=Depends(authenticated)):
        with connect(settings.database) as db:
            db.execute('''INSERT INTO pets (owner_id, name, age, description, color) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(owner_id) DO UPDATE SET name=excluded.name, age=excluded.age,
                description=excluded.description, color=excluded.color''',
                (user, pet.name, pet.age, pet.description, pet.color))
        return me(user)

    @app.post('/api/me/photo')
    async def upload_photo(file: UploadFile, user=Depends(authenticated)):
        content = await file.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise HTTPException(413, 'Фото должно быть не больше 2 МБ.')
        try:
            with Image.open(BytesIO(content)) as source:
                if source.width * source.height > 20_000_000:
                    raise ValueError('image too large')
                image = ImageOps.exif_transpose(source).convert('RGB')
                image.thumbnail((512, 512))
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise HTTPException(422, 'Выберите JPEG, PNG или WebP до 20 мегапикселей.') from None
        filename = f'{uuid4().hex}.jpg'
        target = settings.photos / filename
        old_photo = None
        try:
            with connect(settings.database) as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT photo FROM pets WHERE owner_id = ?', (user,)).fetchone()
                if not row:
                    raise HTTPException(409, 'Сначала сохраните профиль питомца.')
                old_photo = row['photo']
                # Новый JPEG не содержит EXIF с координатами или моделью телефона.
                image.save(target, 'JPEG', quality=85)
                db.execute('UPDATE pets SET photo = ? WHERE owner_id = ?', (f'/photos/{filename}', user))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        if old_photo:
            (settings.photos / Path(old_photo).name).unlink(missing_ok=True)
        return me(user)

    @app.get('/api/pets/{pet_id}')
    def pet(pet_id: int, user=Depends(authenticated)):
        if not -1 <= pet_id < 2 ** 52:
            raise HTTPException(404, 'Профиль не найден.')
        with connect(settings.database) as db:
            row = db.execute('SELECT * FROM pets WHERE owner_id = ?', (pet_id,)).fetchone()
        if not row:
            raise HTTPException(404, 'Профиль не найден.')
        return public_pet(row)

    @app.get('/api/territories')
    def territories(west: float = Query(-180, ge=-180, le=180), south: float = Query(-85, ge=-85, le=85),
                    east: float = Query(180, ge=-180, le=180), north: float = Query(85, ge=-85, le=85),
                    user=Depends(authenticated)):
        if west > east or south > north:
            raise HTTPException(422, 'Некорректная область карты.')
        with connect(settings.database) as db:
            rows = db.execute('''SELECT * FROM territories WHERE max_lon >= ? AND min_lon <= ?
                AND max_lat >= ? AND min_lat <= ? ORDER BY created_at DESC LIMIT 201''', (west, east, south, north)).fetchall()
            pets = {str(row['owner_id']): public_pet(row) for row in db.execute('SELECT * FROM pets WHERE owner_id IN (' + ','.join('?' for _ in rows[:200]) + ')', [row['owner_id'] for row in rows[:200]])} if rows else {}
        return {'territories': [public_territory(row) for row in rows[:200]], 'pets': pets, 'truncated': len(rows) > 200}

    @app.post('/api/walks')
    def start(user=Depends(authenticated)):
        started_at, identifier = time.time(), uuid4().hex
        with connect(settings.database) as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM pets WHERE owner_id = ?', (user,)).fetchone():
                raise HTTPException(409, 'Сначала создайте профиль питомца.')
            db.execute('UPDATE walks SET active = 0 WHERE owner_id = ?', (user,))
            db.execute('DELETE FROM walks WHERE started_at < ?', (started_at - 86400,))
            db.execute('INSERT INTO walks VALUES (?, ?, ?, 1)', (identifier, user, started_at))
        return {'id': identifier, 'startedAt': started_at}

    @app.delete('/api/walks/{walk_id}')
    def cancel(walk_id: str, user=Depends(authenticated)):
        with connect(settings.database) as db:
            db.execute('UPDATE walks SET active = 0 WHERE id = ? AND owner_id = ?', (walk_id, user))
        return {'ok': True}

    @app.post('/api/capture')
    def capture(body: CaptureInput, user=Depends(authenticated)):
        with connect(settings.database) as db:
            db.execute('BEGIN IMMEDIATE')  # владение меняется одним атомарным действием
            walk = db.execute('SELECT * FROM walks WHERE id = ? AND owner_id = ? AND active = 1', (body.walk_id, user)).fetchone()
            if not walk:
                raise HTTPException(409, 'Прогулка завершена или не найдена. Обновите карту и начните новую.')
            try:
                polygon = validate_route([p.model_dump() for p in body.points], started_at=walk['started_at'], now=time.time())
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
            west, south, east, north = polygon.bounds
            candidates = db.execute('''SELECT * FROM territories WHERE max_lon >= ? AND min_lon <= ?
                AND max_lat >= ? AND min_lat <= ?''', (west, east, south, north)).fetchall()
            for old in candidates:
                geometry = shape(json.loads(old['geometry']))
                if not geometry.intersects(polygon):
                    continue
                rest = subtract(geometry, polygon)
                if rest is None:
                    db.execute('DELETE FROM territories WHERE id = ?', (old['id'],))
                else:
                    from shapely.geometry import mapping
                    db.execute('UPDATE territories SET geometry=?, area=?, min_lon=?, min_lat=?, max_lon=?, max_lat=? WHERE id=?',
                               (json.dumps(mapping(rest)), square_meters(rest), *rest.bounds, old['id']))
            identifier = insert_territory(db, polygon, user)
            db.execute('UPDATE walks SET active = 0 WHERE id = ?', (walk['id'],))
        return {'id': identifier, 'area': square_meters(polygon)}

    @app.post('/api/demo/capture')
    def demo_capture(user=Depends(authenticated)):
        if not settings.demo_mode:
            raise HTTPException(404, 'Демонстрация выключена.')
        walk = start(user)
        now = time.time()
        with connect(settings.database) as db:
            db.execute('UPDATE walks SET started_at = ? WHERE id = ?', (now - 180, walk['id']))
        points = [Sample(longitude=lon, latitude=lat, accuracy=3, timestamp=now - 160 + index * 40)
                  for index, (lon, lat) in enumerate(ROUTE)]
        return capture(CaptureInput(walk_id=walk['id'], points=points), user)

    @app.get('/')
    def index():
        return FileResponse(ROOT / 'web/index.html', headers={'Cache-Control': 'no-store'})

    # Фото публичны по непредсказуемому адресу, как и карточки владельцев на карте.
    app.mount('/photos', StaticFiles(directory=settings.photos, check_dir=False), name='photos')
    app.mount('/static', StaticFiles(directory=ROOT / 'web'), name='static')
    app.mount('/', StaticFiles(directory=ROOT / 'web'), name='frontend')
    return app


app = create_app()
