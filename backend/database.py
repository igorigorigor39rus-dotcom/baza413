"""SQLite хранит общую карту. Транзакция захвата не даёт двум запросам потерять изменения."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
import time
from uuid import uuid4

from shapely.geometry import mapping, shape, Polygon

from .geometry import square_meters


@contextmanager
def connect(path: Path):
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys = ON')
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize(path: Path, demo: bool):
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.execute('PRAGMA journal_mode = WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS pets (
                owner_id INTEGER PRIMARY KEY, name TEXT NOT NULL, age REAL NOT NULL,
                description TEXT NOT NULL, color TEXT NOT NULL, photo TEXT
            );
            CREATE TABLE IF NOT EXISTS territories (
                id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES pets(owner_id),
                geometry TEXT NOT NULL, area REAL NOT NULL, created_at REAL NOT NULL,
                min_lon REAL, min_lat REAL, max_lon REAL, max_lat REAL
            );
            CREATE INDEX IF NOT EXISTS territory_bounds ON territories(min_lon, max_lon, min_lat, max_lat);
            CREATE TABLE IF NOT EXISTS walks (
                id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES pets(owner_id),
                started_at REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1
            );
        ''')
        if demo and not db.execute('SELECT 1 FROM pets WHERE owner_id = -1').fetchone():
            db.execute('INSERT INTO pets VALUES (-1, ?, ?, ?, ?, NULL)',
                       ('Бублик', 3, 'Вымышленный сосед. Попробуйте захватить часть его территории!', '#E9A33B'))
            polygon = Polygon([(20.452,54.7103),(20.454,54.7103),(20.454,54.7113),(20.452,54.7113)])
            insert_territory(db, polygon, -1)


def insert_territory(db, polygon, owner_id):
    identifier = uuid4().hex
    db.execute('INSERT INTO territories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
               (identifier, owner_id, json.dumps(mapping(polygon)), square_meters(polygon), time.time(), *polygon.bounds))
    return identifier


def public_pet(row):
    # Только публичный профиль питомца: без имени человека, username и токена Telegram.
    return dict(id=str(row['owner_id']), name=row['name'], age=row['age'],
                description=row['description'], color=row['color'], photo=row['photo'])


def public_territory(row):
    polygon = shape(json.loads(row['geometry']))
    marker = polygon.representative_point()
    return dict(id=row['id'], ownerId=str(row['owner_id']), geometry=mapping(polygon),
                area=row['area'], marker=[marker.y, marker.x])
