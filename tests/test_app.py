"""Запуск: python -m unittest discover -s tests -v. Настоящие Telegram-запросы не отправляются."""
import hashlib
import hmac
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from PIL import Image
from shapely.geometry import Polygon, shape

from backend.app import create_app
from backend.auth import verify_init_data
from backend.config import Settings
from backend.database import connect, insert_territory
from backend.geometry import square_meters, subtract, validate_route

TOKEN = 'test-token-not-a-real-credential'


def signed(user=42, now=None):
    fields = {'auth_date': str(int(time.time() if now is None else now)), 'user': json.dumps({'id': user, 'first_name': 'Тест'})}
    secret = hmac.new(b'WebAppData', TOKEN.encode(), hashlib.sha256).digest()
    fields['hash'] = hmac.new(secret, '\n'.join(f'{k}={v}' for k,v in sorted(fields.items())).encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def samples(coords=None, now=None):
    coords = coords or [(20,54),(20.0002,54),(20.0002,54.0002),(20,54.0002),(20,54)]
    now = time.time() if now is None else now
    return [dict(longitude=lon,latitude=lat,accuracy=3,timestamp=now-(len(coords)-1-i)*3) for i,(lon,lat) in enumerate(coords)]


class AuthTests(unittest.TestCase):
    def test_valid_signature(self):
        self.assertEqual(verify_init_data(signed(),TOKEN),42)

    def test_tampering_expiry_future_duplicates(self):
        for raw in [signed().replace('42','43'), signed(now=time.time()-3602), signed(now=time.time()+100), signed()+'&user=%7B%22id%22%3A43%7D', 'hash=nope']:
            with self.subTest(raw=raw[:20]), self.assertRaises(Exception) as caught:
                verify_init_data(raw,TOKEN)
            self.assertEqual(caught.exception.status_code,401)


class GeometryTests(unittest.TestCase):
    def validate(self, points):
        return validate_route(points,started_at=time.time()-180,now=time.time())

    def test_valid_ring(self):
        self.assertGreater(square_meters(self.validate(samples())),100)

    def test_close_within_five_meters(self):
        points=samples(); points[-1]['latitude']+=0.00002
        self.assertTrue(self.validate(points).is_valid)

    def test_open_tiny_self_crossing_and_line(self):
        variants=[[(20,54),(20.0002,54),(20.0002,54.0002),(20,54.0002)],
                  [(20,54),(20.00001,54),(20.00001,54.00001),(20,54.00001),(20,54)],
                  [(20,54),(20.0002,54.0002),(20,54.0002),(20.0002,54),(20,54)],
                  [(20,54),(20.0002,54),(20.0004,54),(20,54)]]
        for coords in variants:
            with self.subTest(coords=coords), self.assertRaises(ValueError): self.validate(samples(coords))

    def test_bad_accuracy_time_stale_gap_jump(self):
        bad=[]
        p=samples();p[1]['accuracy']=30;bad.append(p)
        p=samples();p[1]['timestamp']=p[0]['timestamp'];bad.append(p)
        bad.append(samples(now=time.time()-30))
        p=samples();p[0]['timestamp']-=60;bad.append(p)
        p=samples();p[1]['longitude']+=0.02;bad.append(p)
        for points in bad:
            with self.subTest(points=points),self.assertRaises(ValueError): self.validate(points)

    def test_hole_split_and_complete_capture(self):
        old=Polygon([(20,54),(20.002,54),(20.002,54.002),(20,54.002)])
        inside=Polygon([(20.0005,54.0005),(20.0015,54.0005),(20.0015,54.0015),(20.0005,54.0015)])
        rest=subtract(old,inside)
        self.assertEqual(len(rest.interiors),1)
        self.assertAlmostEqual(square_meters(rest)+square_meters(inside),square_meters(old),delta=.1)
        stripe=Polygon([(20.0008,53.999),(20.0012,53.999),(20.0012,54.003),(20.0008,54.003)])
        split=subtract(old,stripe)
        self.assertEqual(split.geom_type,'MultiPolygon');self.assertEqual(len(split.geoms),2)
        self.assertIsNone(subtract(old,old))


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp=TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.settings=Settings(bot_token=TOKEN,data_dir=Path(self.temp.name))
        self.client=TestClient(create_app(self.settings));self.client.__enter__()
        self.addCleanup(self.client.__exit__,None,None,None)
        self.client.headers['Authorization']='tma '+signed()

    def profile(self, user=None):
        headers={'Authorization':'tma '+signed(user)} if user else {}
        return self.client.put('/api/me',headers=headers,json={'name':'Ричи','age':3,'description':'Любит мяч','color':'#397C63'})

    def walk(self, user=None):
        headers={'Authorization':'tma '+signed(user)} if user else {}
        response=self.client.post('/api/walks',headers=headers);self.assertEqual(response.status_code,200)
        walk=response.json()
        # Имитируем прошедшие 20 секунд вместо ожидания настоящей прогулки в тесте.
        with connect(self.settings.database) as db:
            db.execute('UPDATE walks SET started_at=? WHERE id=?',(time.time()-20,walk['id']))
        return walk['id']

    def test_auth_required_and_spoofed_headers_rejected(self):
        for headers in [{'Authorization':''},{'Authorization':'tma user=42&hash=fake'}]:
            self.assertEqual(self.client.get('/api/me',headers=headers).status_code,401)

    def test_profile_validation_persistence_and_owner_visibility(self):
        self.assertIsNone(self.client.get('/api/me').json()['pet'])
        self.assertEqual(self.profile().status_code,200)
        self.assertEqual(self.client.get('/api/me').json()['pet']['name'],'Ричи')
        public=self.client.get('/api/pets/42').json()
        self.assertNotIn('first_name',public)
        self.assertEqual(self.client.put('/api/me',json={'name':' ','age':-1,'color':'bad'}).status_code,422)
        with connect(self.settings.database) as db:
            self.assertEqual(db.execute('SELECT name FROM pets WHERE owner_id=42').fetchone()[0],'Ричи')

    def test_capture_and_replay_and_other_user(self):
        self.profile();walk=self.walk()
        self.profile(user=43)
        body={'walk_id':walk,'points':samples()}
        self.assertEqual(self.client.post('/api/capture',headers={'Authorization':'tma '+signed(43)},json=body).status_code,409)
        result=self.client.post('/api/capture',json=body)
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(self.client.post('/api/capture',json=body).status_code,409)
        self.assertGreater(self.client.get('/api/me').json()['area'],100)
        self.assertEqual(len(self.client.get('/api/territories').json()['territories']),1)

    def test_open_route_does_not_close_walk(self):
        self.profile();walk=self.walk();points=samples()
        points[-1]['latitude']+=.0002
        self.assertEqual(self.client.post('/api/capture',json={'walk_id':walk,'points':points}).status_code,422)
        self.assertEqual(self.client.post('/api/capture',json={'walk_id':walk,'points':samples()}).status_code,200)

    def test_recapture_shared_map_has_no_overlap(self):
        self.profile();self.profile(user=43)
        old=Polygon([(20.0001,54.0001),(20.0003,54.0001),(20.0003,54.0003),(20.0001,54.0003)])
        with connect(self.settings.database) as db: insert_territory(db,old,43)
        response=self.client.post('/api/capture',json={'walk_id':self.walk(),'points':samples()})
        self.assertEqual(response.status_code,200,response.text)
        lands=self.client.get('/api/territories').json()['territories']
        self.assertEqual(len(lands),2)
        a,b=[shape(t['geometry']) for t in lands]
        self.assertEqual(a.intersection(b).area,0)
        self.assertLess(next(t['area'] for t in lands if t['ownerId']=='43'),square_meters(old))

    def test_concurrent_capture_is_atomic(self):
        self.profile();self.profile(user=43)
        first=self.walk();second=self.walk(user=43)
        def capture(args):
            user,walk=args
            return self.client.post('/api/capture',headers={'Authorization':'tma '+signed(user)},json={'walk_id':walk,'points':samples()}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(list(executor.map(capture,[(42,first),(43,second)])),[200,200])
        self.assertEqual(len(self.client.get('/api/territories').json()['territories']),1)

    def test_cancel_and_new_walk_invalidate_previous(self):
        self.profile();first=self.walk();second=self.walk()
        self.assertEqual(self.client.post('/api/capture',json={'walk_id':first,'points':samples()}).status_code,409)
        self.client.delete('/api/walks/'+second)
        self.assertEqual(self.client.post('/api/capture',json={'walk_id':second,'points':samples()}).status_code,409)

    def test_photo_reencodes_and_rejects_non_image_and_oversize(self):
        self.profile()
        stream=BytesIO();Image.new('RGB',(40,40),'green').save(stream,'PNG')
        response=self.client.post('/api/me/photo',files={'file':('pet.png',stream.getvalue(),'image/png')})
        self.assertEqual(response.status_code,200,response.text)
        path=response.json()['pet']['photo']
        self.assertEqual(self.client.get(path).headers['content-type'],'image/jpeg')
        self.assertEqual(self.client.post('/api/me/photo',files={'file':('bad.svg',b'<svg/>','image/svg+xml')}).status_code,422)
        self.assertEqual(self.client.post('/api/me/photo',files={'file':('large.jpg',b'0'*(2*1024*1024+1),'image/jpeg')}).status_code,413)
        self.assertEqual(self.client.put('/api/me',content=b'0'*(3*1024*1024+1)).status_code,413)

    def test_demo_disabled_and_static_files_available(self):
        self.assertEqual(self.client.post('/api/demo/capture').status_code,404)
        self.assertFalse(self.client.get('/api/config').json()['demoMode'])
        self.assertEqual(self.client.get('/').status_code,200)
        self.assertEqual(self.client.get('/static/app.js').status_code,200)
        self.assertEqual(self.client.get('/static/vendor/leaflet/leaflet.js').status_code,200)

    def test_bbox_filters_and_invalid_bounds(self):
        self.profile();self.client.post('/api/capture',json={'walk_id':self.walk(),'points':samples()})
        self.assertFalse(self.client.get('/api/territories?west=0&east=1&south=0&north=1').json()['territories'])
        self.assertEqual(self.client.get('/api/territories?west=10&east=1').status_code,422)


class DemoTests(unittest.TestCase):
    def test_isolation_and_demo_capture(self):
        with TemporaryDirectory() as directory:
            settings=Settings(demo_mode=True,data_dir=Path(directory))
            self.assertNotEqual(settings.database,Settings(data_dir=Path(directory)).database)
            with TestClient(create_app(settings)) as client:
                self.assertEqual(client.post('/api/demo/capture').status_code,409)
                client.put('/api/me',json={'name':'Тест','age':1,'color':'#397C63'})
                self.assertEqual(client.post('/api/demo/capture').status_code,200)
                self.assertEqual(len(client.get('/api/territories').json()['territories']),2)


if __name__ == '__main__': unittest.main()
