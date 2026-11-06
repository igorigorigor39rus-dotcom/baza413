"""Одноразовая PostGIS: базовая миграция + накопительная v.0.6.

POSTGIS_CONTAINER=baza413-postgis-v06 python tests/v06_checks.py -v
Эти проверки нельзя запускать на рабочей базе.
"""
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

import v04_checks
from postgis_checks import ROOT, call, literal, route, sql


class V06Checks(v04_checks.V04Checks):
    def setUp(self):
        sql('truncate paws.purchases,paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet', p_user=42, p_name='Генерал', p_age=3, p_description='', p_color='#397C63')

    def walk(self, live=False):
        walk = (call('paws_live_start', p_user=42, p_accuracy=20)['walk']['id'] if live
                else call('paws_start', p_user=42)['id'])
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '300 seconds' where id={literal(walk)}")
        return walk

    def points(self, coordinates):
        now = time.time()
        return [dict(longitude=20+x, latitude=54+y, accuracy=20, timestamp=now-20*(len(coordinates)-1-i))
                for i, (x, y) in enumerate(coordinates)]

    def receive(self, point, update=1, initial=True, message=77, sent_at=None, user=42):
        return call('paws_live_receive', p_user=user, p_message=message, p_update=update,
                    p_timestamp=point['timestamp'], p_sent_at=point['timestamp'] if sent_at is None else sent_at,
                    p_longitude=point['longitude'], p_latitude=point['latitude'],
                    p_accuracy=point['accuracy'], p_period=3600, p_initial=initial)

    def capture(self, points, live=False):
        walk = self.walk(live)
        if live:
            for i, p in enumerate(points):
                self.assertTrue(call('paws_live_point', p_user=42, p_message=77, p_update=i+1,
                                     p_timestamp=p['timestamp'], p_longitude=p['longitude'], p_latitude=p['latitude'],
                                     p_accuracy=p['accuracy'], p_period=3600)['accepted'])
            result = call('paws_live_capture', p_user=42)
            self.assertEqual(sql('select points from paws.live_walks where walk_id='+literal(walk)), '[]')
        else:
            result = call('paws_capture', p_user=42, p_walk=walk, p_points=points)
        return result

    def assert_valid(self):
        self.assertEqual(sql('select bool_and(ST_IsValid(geom)) from paws.territories'), 't')
        self.assertEqual(sql('select sum(ST_NumInteriorRings(p.geom)) from paws.territories t cross join lateral ST_Dump(t.geom) p'), '0')

    def test_crossing_eight_foreground_and_live(self):
        for live in (False, True):
            points = self.points([(0,0),(.001,.001),(0,.001),(.001,0),(0,0)])
            result = self.capture(points, live)
            expected = float(sql('select ST_Area(ST_MakeEnvelope(20,54,20.001,54.001,4326)::geography)'))/2
            self.assertAlmostEqual(result['area'], expected, delta=.5)
            self.assert_valid()
            self.assertEqual(sql('select ST_NumGeometries(geom) from paws.territories'), '2')

    def test_inner_loops_and_double_pass_count_outer_area_once(self):
        outer = [(0,0),(.002,0),(.002,.002),(0,.002),(0,0)]
        routes = [outer+outer[1:], outer+[(.0005,.0005),(.0015,.0005),(.0015,.0015),(.0005,.0015),(.0005,.0005),(0,0)]]
        expected = float(sql('select ST_Area(ST_MakeEnvelope(20,54,20.002,54.002,4326)::geography)'))
        for coordinates in routes:
            result = self.capture(self.points(coordinates))
            self.assertAlmostEqual(result['area'], expected, delta=.01)
            self.assert_valid()

    def test_concave_boundary_and_spur_do_not_add_unwalked_area(self):
        self.capture(self.points([(0,0),(.002,0),(.002,.001),(.001,.001),(.001,.002),(0,.002),(0,0)]))
        self.assertEqual(sql('select ST_Covers(geom,ST_SetSRID(ST_MakePoint(20.0015,54.0015),4326)) from paws.territories'), 'f')
        result = self.capture(self.points([(0,0),(.003,0),(.004,0),(.004,.001),(.003,.001),(.003,0),(0,0)]))
        expected = float(sql('select ST_Area(ST_MakeEnvelope(20.003,54,20.004,54.001,4326)::geography)'))
        self.assertAlmostEqual(result['area'], expected, delta=.01)
        self.assert_valid()

    def test_accuracy_20_and_closure_20_both_modes(self):
        for live in (False, True):
            points = self.points([(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,.00017)])
            self.assertGreater(self.capture(points, live)['area'], 25)
        for accuracy in (20.001, -1):
            with self.assertRaises(AssertionError): call('paws_live_start', p_user=42, p_accuracy=accuracy)
        for case in ('open', 'accuracy', 'line'):
            walk = self.walk()
            points = self.points([(0,0),(.001,0),(.001,.001),(0,.001),(0,0)])
            if case == 'open': points[-1]['latitude'] += .0002
            elif case == 'accuracy': points[-1]['accuracy'] = 20.001
            else: points = self.points([(0,0),(.001,0),(.002,0),(0,0)])
            with self.assertRaises(AssertionError): call('paws_capture', p_user=42, p_walk=walk, p_points=points)
            self.assertEqual(sql('select active from paws.walks where id='+literal(walk)), 't')

    def test_auto_start_waits_for_accuracy_and_updates_do_not_restart_cancelled_walk(self):
        now = time.time()
        point = dict(longitude=20, latitude=54, accuracy=25, timestamp=now)
        result = self.receive(point)
        self.assertTrue(result['prepared']); self.assertFalse(result['accepted'])
        self.assertEqual(call('paws_live_status', p_user=42)['walk']['points'], [])
        point.update(accuracy=20, timestamp=now+1)
        accepted = self.receive(point, update=2, initial=False, sent_at=now)
        self.assertTrue(accepted['accepted']); self.assertTrue(accepted['first'])
        self.assertFalse(self.receive(point, update=2, initial=False, sent_at=now)['accepted'])
        call('paws_live_cancel', p_user=42)
        self.assertEqual(sql('select points from paws.live_walks'), '[]')
        self.assertEqual(self.receive(point, update=3, initial=False, sent_at=now)['reason'], 'closed')
        self.assertEqual(self.receive({**point,'timestamp':now}, update=1)['reason'], 'closed')
        self.assertIsNone(call('paws_live_status', p_user=42)['walk'])
        self.assertTrue(self.receive({**point,'timestamp':now}, update=4, message=78)['accepted'])

    def test_auto_start_guards_and_closed_capture(self):
        now = time.time()
        point = dict(longitude=20, latitude=54, accuracy=20, timestamp=now)
        self.assertEqual(self.receive(point, initial=False)['reason'], 'no_walk')
        self.assertEqual(self.receive({**point,'timestamp':now-60})['reason'], 'old')
        self.assertEqual(self.receive(point, user=99)['reason'], 'profile')
        self.walk()
        self.assertEqual(self.receive(point)['reason'], 'foreground_active')
        sql('update paws.walks set active=false')
        self.assertTrue(self.receive(point)['first'])
        # Последующие координаты из той же трансляции образуют реальный контур.
        coords = [(0,0),(.0002,0),(.0002,.0002),(0,.0002),(0,0)]
        for i, (x,y) in enumerate(coords[1:]):
            p = dict(longitude=20+x, latitude=54+y, accuracy=20, timestamp=now+i+1)
            self.assertTrue(self.receive(p, update=i+2, initial=False, sent_at=now)['accepted'])
        result = call('paws_live_capture', p_user=42)
        self.assertEqual(call('paws_live_capture', p_user=42)['id'], result['id'])
        self.assertEqual(self.receive(point, update=20, initial=False, sent_at=now)['reason'], 'closed')

    def test_stale_stream_cannot_attach_to_new_prepared_walk(self):
        self.walk(live=True)
        point = dict(longitude=20, latitude=54, accuracy=20, timestamp=time.time())
        self.assertEqual(self.receive(point, initial=False, sent_at=time.time()-600)['reason'], 'old')

    def test_migration_does_not_reset_balance(self):
        self.land(); sql('update paws.wallets set balance=123 where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060004_v06.sql').read_text())
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'), '123')
        self.assertTrue(call('paws_capabilities')['crossingRoutes'])
        self.assertEqual(sql("select has_function_privilege('anon','public.paws_live_receive(bigint,bigint,bigint,double precision,double precision,double precision,double precision,double precision,integer,boolean)','execute')"), 'f')

    def purchase_vertices(self, x=20, width=.0002):
        return [dict(longitude=lon,latitude=lat) for lon,lat in [(x,54),(x+width,54),(x+width,54.0002),(x,54.0002)]]

    def fund(self, user=42):
        sql(f'insert into paws.wallets(owner_id,balance) values({user},1000000) on conflict(owner_id) do update set balance=1000000,checked_at=clock_timestamp()')

    def test_purchase_cost_atomic_balance_and_idempotent_receipt(self):
        vertices=self.purchase_vertices();self.fund()
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertEqual(quote['cost'],__import__('math').ceil(quote['area']*10))
        request=str(uuid.uuid4())
        result=call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost'])
        self.assertEqual(float(sql('select balance from paws.wallets where owner_id=42')),1000000-quote['cost'])
        self.assertEqual(call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost']),result)
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertEqual(sql("select has_table_privilege('anon','paws.purchases','select')"),'f')
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],quote['area'],delta=.01)

    def test_purchase_rejects_occupied_insufficient_funds_and_changed_cost(self):
        vertices=self.purchase_vertices()
        with self.assertRaises(AssertionError):call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1000000)
        self.assertEqual(sql('select count(*) from paws.territories'),'0')
        self.fund();before=sql('select balance from paws.wallets where owner_id=42')
        with self.assertRaises(AssertionError):call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1)
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),before)
        self.land()
        with self.assertRaises(AssertionError):call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        # У соседнего участка общая граница допустима, площадь не пересекается.
        self.assertTrue(call('paws_purchase_quote',p_user=42,p_vertices=self.purchase_vertices(x=20.0002))['affordable'])

    def test_two_buyers_cannot_purchase_same_free_land(self):
        call('paws_save_pet',p_user=43,p_name='Сосед',p_age=2,p_description='',p_color='#397C63')
        self.fund(42);self.fund(43);vertices=self.purchase_vertices()
        def buy(user):
            try:return call('paws_purchase',p_user=user,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1000000)
            except AssertionError:return None
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(buy,[42,43]))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertEqual(sql('select count(*) from paws.purchases'),'1')
        self.assertEqual(sql('select count(*) from paws.wallets where balance=1000000'),'1')

    def test_area_ranking_changes_on_recapture_and_contains_purchases(self):
        self.fund();vertices=self.purchase_vertices()
        call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1000000)
        call('paws_save_pet',p_user=43,p_name='Сосед',p_age=2,p_description='',p_color='#397C63')
        top=call('paws_top_area',p_user=43)['agents'];self.assertEqual(top[0]['pet']['id'],'42')
        walk=call('paws_start',p_user=43)['id']
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '120 seconds' where id={literal(walk)}")
        call('paws_capture',p_user=43,p_walk=walk,p_points=route(width=.0002,height=.0002))
        top=call('paws_top_area',p_user=42)['agents'];self.assertEqual(top[0]['pet']['id'],'43');self.assertEqual(top[-1]['area'],0)


if __name__ == '__main__': unittest.main()
