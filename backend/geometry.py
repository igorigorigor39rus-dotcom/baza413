"""Чистая геометрия: не зависит от Telegram, HTTP, экрана или базы данных."""
from math import isfinite

from pyproj import Geod
from shapely.geometry import Polygon, MultiPolygon
from shapely.geometry.polygon import orient

GEOD = Geod(ellps='WGS84')
CLOSURE_METERS = 5
MAX_ACCURACY = 15


def meters(a, b):
    """Координаты GeoJSON: (долгота, широта). Расстояние — по поверхности Земли."""
    return GEOD.inv(a[0], a[1], b[0], b[1])[2]


def square_meters(geometry):
    if isinstance(geometry, Polygon):
        # Ориентация важна: отверстия должны вычитаться из площади.
        return abs(GEOD.geometry_area_perimeter(orient(geometry, sign=1))[0])
    return sum(square_meters(part) for part in geometry.geoms)


def polygon_parts(geometry):
    """Разность полигонов иногда содержит линии нулевой площади: их не сохраняем."""
    if isinstance(geometry, Polygon):
        return [geometry] if not geometry.is_empty else []
    return [p for part in getattr(geometry, 'geoms', []) for p in polygon_parts(part)]


def subtract(old, new):
    parts = polygon_parts(old.difference(new))
    return MultiPolygon(parts) if len(parts) > 1 else parts[0] if parts else None


def validate_route(samples, *, started_at: float, now: float):
    """Проверяет форму и правдоподобность записи; это ещё не защита от подмены GPS."""
    if not 4 <= len(samples) <= 5000:
        raise ValueError('Нужно от 4 до 5000 GPS-точек.')
    if now - started_at > 7200:
        raise ValueError('Прогулка длится больше 2 часов. Начните новую.')
    coordinates = []
    previous = None
    for sample in samples:
        lon, lat = sample['longitude'], sample['latitude']
        timestamp, accuracy = sample['timestamp'], sample['accuracy']
        if not all(isfinite(v) for v in (lon, lat, timestamp, accuracy)) or not (-180 <= lon <= 180 and -85 <= lat <= 85):
            raise ValueError('Некорректные координаты GPS.')
        if not 0 <= accuracy <= MAX_ACCURACY:
            raise ValueError('Нужна точность GPS не хуже 15 м.')
        if not started_at - 5 <= timestamp <= now + 30:
            raise ValueError('Время GPS не соответствует прогулке. Проверьте часы телефона.')
        current = (lon, lat)
        if meters((samples[0]['longitude'], samples[0]['latitude']), current) > 10000:
            raise ValueError('Для первой версии маршрут должен оставаться в радиусе 10 км от старта.')
        if previous:
            gap = timestamp - previous['timestamp']
            if gap <= 0 or gap > 45:
                raise ValueError('В записи есть перерыв GPS больше 45 секунд или нарушен порядок точек. Начните новую прогулку.')
            if meters((previous['longitude'], previous['latitude']), current) > 20 * gap + 30:
                raise ValueError('Обнаружен слишком большой скачок GPS. Начните новую прогулку.')
        if not coordinates or current != coordinates[-1]:
            coordinates.append(current)
        previous = sample
    if now - samples[-1]['timestamp'] > 15:
        raise ValueError('Нет свежего GPS: дождитесь точного местоположения.')
    if len(set(coordinates)) < 3:
        raise ValueError('Обойдите участок: точек для площади пока недостаточно.')
    distance = meters(coordinates[0], coordinates[-1])
    if distance > CLOSURE_METERS:
        raise ValueError(f'До старта {distance:.0f} м. Подойдите на расстояние не больше 5 м.')
    if coordinates[-1] != coordinates[0]:
        coordinates.append(coordinates[0])
    poly = Polygon(coordinates)
    if not poly.is_valid or not poly.exterior.is_simple:
        raise ValueError('Контур пересекает сам себя. Начните прогулку с простым контуром.')
    area = square_meters(poly)
    if not 25 <= area <= 10_000_000:
        raise ValueError('Площадь должна быть от 25 м² до 10 км².')
    return poly
