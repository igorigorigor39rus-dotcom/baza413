"""Проверки настоящей PostGIS в ОДНОРАЗОВОМ Docker-контейнере, не вашего Supabase.

Сначала примените migration и tests/postgis_bootstrap.sql в контейнере.
Запуск: python tests/postgis_checks.py. Имя можно изменить через POSTGIS_CONTAINER.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import time
import unittest

ROOT=Path(__file__).resolve().parent.parent
CONTAINER=os.getenv('POSTGIS_CONTAINER','baza413-postgis-check')


def sql(text,check=True):
    environment=os.environ.copy()
    for key in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'):
        environment.pop(key,None)
    command=['docker','--host=unix:///var/run/docker.sock','exec','-i',CONTAINER,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-qtA']
    result=subprocess.run(command,input='set client_min_messages=warning;\n'+text,text=True,capture_output=True,env=environment,timeout=30)
    if check and result.returncode: raise AssertionError(result.stderr)
    return result.stdout.strip() if check else result


def literal(value): return "'"+str(value).replace("'","''")+"'"
def call(name,**kwargs):
    args=','.join(f'{key}=>{literal(json.dumps(value))}::jsonb' if isinstance(value,(list,dict)) else f'{key}=>{literal(value)}' for key,value in kwargs.items())
    return json.loads(sql(f'select public.{name}({args});'))


def route(x=20,y=54,width=.002,height=.002):
    coords=[(x,y),(x+width,y),(x+width,y+height),(x,y+height),(x,y)]
    now=time.time()
    return [dict(longitude=lon,latitude=lat,accuracy=3,timestamp=now-80+i*20) for i,(lon,lat) in enumerate(coords)]


class PostGISTests(unittest.TestCase):
    def setUp(self):
        sql('truncate paws.walks,paws.territories,paws.pets;')

    def pet(self,user=42): return call('paws_save_pet',p_user=user,p_name='Ричи',p_age=3,p_description='Мяч',p_color='#397C63')
    def walk(self,user=42):
        self.pet(user);walk=call('paws_start',p_user=user)['id']
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '120 seconds' where id={literal(walk)};")
        return walk
    def capture(self,walk,points=None,user=42): return call('paws_capture',p_user=user,p_walk=walk,p_points=points or route())

    def test_01_profile_and_persistence(self):
        result=self.pet();self.assertEqual(result['pet']['name'],'Ричи')
        self.assertEqual(call('paws_me',p_user=42)['pet']['id'],'42')
        self.assertIsNone(call('paws_me',p_user=99)['pet'])

    def test_02_capture_idempotency_and_area(self):
        walk=self.walk();result=self.capture(walk)
        self.assertGreater(result['area'],10000)
        self.assertEqual(self.capture(walk),result)
        self.assertEqual(sql('select count(*) from paws.territories;'),'1')

    def test_03_reject_other_owner_cancel_and_old_walk(self):
        first=self.walk();second=self.walk();self.pet(43)
        for walk,user in [(first,42),(second,43)]:
            with self.assertRaises(AssertionError): self.capture(walk,user=user)
        call('paws_cancel',p_user=42,p_walk=second)
        with self.assertRaises(AssertionError): self.capture(second)

    def test_04_invalid_gps_and_open_route_do_not_consume_walk(self):
        walk=self.walk()
        variants=[]
        p=route();p[-1]['latitude']+=.002;variants.append(p)
        p=route();p[1]['accuracy']=16;variants.append(p)
        p=route();p[1]['timestamp']=p[0]['timestamp'];variants.append(p)
        p=route();p[1]['longitude']+=.1;variants.append(p)
        p=route();p[0]['timestamp']-=50;variants.append(p)
        p=route();p[1],p[2]=p[2],p[1];p[1]['timestamp'],p[2]['timestamp']=p[2]['timestamp'],p[1]['timestamp'];variants.append(p)
        for points in variants:
            with self.subTest(points=points),self.assertRaises(AssertionError): self.capture(walk,points)
        self.assertGreater(self.capture(walk)['area'],0)

    def test_05_partial_recapture_holes_and_islands(self):
        self.capture(self.walk())
        original=float(sql('select sum(area) from paws.territories;'))
        # Внутренний маленький участок оставляет отверстие у первого владельца.
        inside=route(20.0005,54.0005,.001,.001)
        self.capture(self.walk(43),inside,user=43)
        self.assertEqual(sql('select sum(ST_NumInteriorRings(parts.geom)) from paws.territories t cross join lateral ST_Dump(t.geom) parts where owner_id=42;'),'1')
        self.assertAlmostEqual(float(sql('select sum(area) from paws.territories;')),original,delta=1)
        self.assertEqual(sql('select coalesce(sum(ST_Area(ST_Intersection(a.geom,b.geom)::geography)),0) from paws.territories a join paws.territories b on a.id<b.id;'),'0')
        # Сквозная полоса разделяет оставшуюся территорию на островки.
        stripe=route(20.0008,53.9995,.0004,.003)
        self.capture(self.walk(43),stripe,user=43)
        self.assertGreaterEqual(int(sql('select max(ST_NumGeometries(geom)) from paws.territories where owner_id=42;')),2)

    def test_06_concurrent_capture_atomic(self):
        first=self.walk();second=self.walk(43)
        def capture(args):
            user,walk=args
            return self.capture(walk,user=user)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(capture,[(42,first),(43,second)]))
        self.assertTrue(all(r['area']>0 for r in results))
        self.assertEqual(sql('select count(*) from paws.territories;'),'1')

    def test_07_permissions_and_service_role(self):
        self.pet()
        for role in ('anon','authenticated'):
            self.assertEqual(sql(f"select has_function_privilege('{role}','public.paws_me(bigint)','execute');"),'f')
            r=sql(f'set role {role}; select * from paws.pets;',check=False)
            self.assertNotEqual(r.returncode,0)
        self.assertIn('Ричи',sql('set role service_role; select public.paws_me(42);'))
        self.assertEqual(sql("select bool_and(relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='paws' and c.relkind='r';"),'t')
        # Широкая старая Storage-политика не должна разрешить запись в наш bucket.
        setup="begin;grant usage on schema storage to anon;grant all on storage.objects to anon;create policy test_open on storage.objects for all to anon using(true) with check(true);set local role anon;"
        sql(setup+"insert into storage.objects(bucket_id) values('other-bucket');rollback;")
        self.assertNotEqual(sql(setup+"insert into storage.objects(bucket_id) values('paws-photos');rollback;",check=False).returncode,0)

    def test_08_viewport_and_repeated_migration(self):
        self.capture(self.walk())
        empty=call('paws_map',p_user=42,p_west=0,p_east=1,p_south=0,p_north=1)
        self.assertEqual(empty['territories'],[])
        local=call('paws_map',p_user=42,p_west=19,p_east=21,p_south=53,p_north=55)
        self.assertEqual(local['pets']['42']['name'],'Ричи');self.assertEqual(len(local['territories']),1)
        sql((ROOT/'supabase/migrations/202611050001_paws.sql').read_text())
        self.assertEqual(sql('select count(*) from paws.territories;'),'1')
        self.assertEqual(call('paws_me',p_user=42)['pet']['name'],'Ричи')


if __name__=='__main__': unittest.main()
