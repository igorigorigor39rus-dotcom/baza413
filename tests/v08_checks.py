"""Одноразовая PostGIS: базовая + накопительная v.0.8. Проверка скорости WGS84."""
import json
import time
import unittest

from pyproj import Geod
import v071_checks
from postgis_checks import ROOT, call, literal, sql

GEOD=Geod(ellps='WGS84')
WARNING='Ай яй яй, захват аннулирован, играй честно'


class V08Checks(v071_checks.V071Checks):
    def setUp(self):
        sql('truncate paws.star_refunds,paws.star_payments,paws.star_orders,paws.star_debts,paws.payment_issues,paws.payment_support,paws.reminder_messages,paws.activity,paws.notifications,paws.purchases,paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397C63')
    # Старые геометрические сценарии не должны сами имитировать автомобиль.
    def points(self,coords):
        now=time.time()-1
        return [dict(longitude=20+x,latitude=54+y,accuracy=20,timestamp=now-40*(len(coords)-1-i)) for i,(x,y) in enumerate(coords)]

    def walk(self,live=False):
        walk=super().walk(live)
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '600 seconds' where id={literal(walk)}")
        return walk

    def timed(self,speed,coords=None):
        coords=coords or [(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,0)]
        p=self.points(coords)
        distance=sum(GEOD.inv(a['longitude'],a['latitude'],b['longitude'],b['latitude'])[2] for a,b in zip(p,p[1:]))
        elapsed=distance/(speed/3.6);end=time.time()-1
        for i,item in enumerate(p):item['timestamp']=end-elapsed+elapsed*i/(len(p)-1)
        return p

    def run_capture(self,points,live=False):
        walk=self.walk(live)
        if live:
            for i,p in enumerate(points):
                accepted=call('paws_live_point',p_user=42,p_message=77,p_update=i+1,p_timestamp=p['timestamp'],
                              p_longitude=p['longitude'],p_latitude=p['latitude'],p_accuracy=p['accuracy'],p_period=3600)
                self.assertTrue(accepted['accepted'])
            result=call('paws_live_capture',p_user=42)
        else:result=call('paws_capture',p_user=42,p_walk=walk,p_points=points)
        return walk,result

    def capture(self,points,live=False):
        # Все синтетические точки доставляем одной SQL-командой, чтобы время
        # запуска Docker не превратило свежий маршрут в просроченный GPS.
        if not live:return super().capture(points,live)
        walk=self.walk(True)
        calls=[]
        for i,p in enumerate(points):
            calls.append(f"select public.paws_live_point(42,77,{i+1},{p['timestamp']},{p['longitude']},{p['latitude']},{p['accuracy']},3600);")
        accepted=sql(''.join(calls)).splitlines()
        self.assertTrue(all(json.loads(row)['accepted'] for row in accepted))
        result=call('paws_live_capture',p_user=42)
        self.assertEqual(sql('select points from paws.live_walks where walk_id='+literal(walk)),'[]')
        return result

    def test_speed_boundary_in_both_modes(self):
        for live in (False,True):
            for speed in (19.9,20,20.01,40):
                with self.subTest(live=live,speed=speed):
                    self.setUp()
                    walk,result=self.run_capture(self.timed(speed),live)
                    self.assertEqual(bool(result.get('annulled')),speed>20)
                    if speed>20:
                        self.assertEqual(result['detail'],WARNING)
                        self.assertAlmostEqual(result['averageSpeedKmh'],speed,places=4)
                        self.assertEqual(sql('select count(*) from paws.territories'),'0')
                    else:self.assertGreater(result['area'],25)

    def test_annulment_persists_and_retry_cannot_resubmit_slow_track(self):
        for live in (False,True):
            self.setUp();self.seller();self.fund()
            before=sql('select json_agg(row_to_json(t) order by id) from paws.territories t')
            wallets=sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w')
            walk,result=self.run_capture(self.timed(40),live)
            self.assertTrue(result['annulled'])
            self.assertEqual(sql('select active from paws.walks where id='+literal(walk)),'f')
            retry=call('paws_live_capture',p_user=42) if live else call('paws_capture',p_user=42,p_walk=walk,p_points=self.timed(4))
            self.assertEqual(retry,result)
            self.assertEqual(sql('select json_agg(row_to_json(t) order by id) from paws.territories t'),before)
            self.assertEqual(sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w'),wallets)
            self.assertEqual(sql('select count(*) from paws.notifications'),'0')
            self.assertEqual(sql('select count(*) from paws.purchases'),'0')
            if live:
                self.assertEqual(sql('select points from paws.live_walks'),'[]')
                self.assertEqual(call('paws_live_status',p_user=42)['result'],result)

    def test_full_trajectory_includes_repeated_laps(self):
        coords=[(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,0)]
        _,result=self.run_capture(self.timed(30,coords))
        self.assertTrue(result['annulled'])
        self.assertAlmostEqual(result['averageSpeedKmh'],30,places=4)

    def test_synthetic_closure_segment_is_not_added_to_speed(self):
        _,result=self.run_capture(self.timed(20,[(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,.0001)]))
        self.assertGreater(result['area'],25)

    def test_very_fast_browser_track_uses_annulment_message(self):
        _,result=self.run_capture(self.timed(150))
        self.assertTrue(result['annulled']);self.assertEqual(result['detail'],WARNING)

    def test_gps_capture_foreground_and_live_never_pay_reparations(self):
        for live in (False,True):
            self.setUp();self.seller()
            before=json.loads(sql("select json_build_object('balance',w.balance,'asOf',extract(epoch from w.checked_at),'area',t.area) from paws.wallets w join paws.territories t on t.owner_id=w.owner_id where w.owner_id=43"))
            result=self.capture(self.points([(0,0),(.0002,0),(.0002,.0002),(0,.0002),(0,0)]),live=live)
            after=json.loads(sql("select json_build_object('balance',balance,'asOf',extract(epoch from checked_at)) from paws.wallets where owner_id=43"))
            expected=before['balance']+before['area']*(after['asOf']-before['asOf'])/3600
            self.assertGreater(result['area'],0)
            self.assertAlmostEqual(after['balance'],expected,delta=.00001)
            self.assertEqual(sql('select count(*) from paws.notifications'),'0')
            self.assertEqual(sql('select count(*) from paws.purchases'),'0')

    def test_auto_start_guards_and_closed_capture(self):
        # Проверяем прежнюю привязку live location на небольшом пешем контуре.
        now=time.time();point=dict(longitude=20,latitude=54,accuracy=20,timestamp=now)
        self.assertEqual(self.receive(point,initial=False)['reason'],'no_walk')
        self.assertEqual(self.receive({**point,'timestamp':now-60})['reason'],'old')
        self.assertEqual(self.receive(point,user=99)['reason'],'profile')
        self.assertTrue(self.receive(point)['first'])
        for i,(x,y) in enumerate([(.00006,0),(.00006,.00006),(0,.00006),(0,0)]):
            self.assertTrue(self.receive(dict(longitude=20+x,latitude=54+y,accuracy=20,timestamp=now+i+1),update=i+2,initial=False,sent_at=now)['accepted'])
        result=call('paws_live_capture',p_user=42)
        self.assertGreater(result['area'],25)
        self.assertEqual(call('paws_live_capture',p_user=42),result)

    def test_stale_stream_cannot_attach_to_new_prepared_walk(self):
        self.walk(live=True)
        point=dict(longitude=20,latitude=54,accuracy=20,timestamp=time.time())
        self.assertEqual(self.receive(point,initial=False,sent_at=time.time()-1200)['reason'],'old')

    def test_gps_jump_is_quality_error_before_speed_accusation(self):
        points=self.timed(8);points[1]['longitude']+=.02
        walk=self.walk()
        with self.assertRaises(AssertionError):call('paws_capture',p_user=42,p_walk=walk,p_points=points)
        self.assertEqual(sql('select result is null from paws.walks where id='+literal(walk)),'t')

    def test_migration_does_not_reset_balance(self):
        self.seller();self.fund();self.buy()
        before=sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w')
        sql((ROOT/'supabase/migrations/202611060007_v08.sql').read_text())
        self.assertEqual(sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w'),before)
        self.assertTrue(call('paws_capabilities')['speedLimit'])

    def order(self,request='order1'):
        return call('paws_star_order',p_user=42,p_package='00000000-0000-0000-0000-000000000100',p_request=request)

    def checkout(self,o,**extra):
        return call('paws_star_checkout',**dict(dict(p_user=42,p_order=o['id'],p_currency='XTR',p_amount=100,p_query='q'),**extra))

    def payment(self,o,charge='charge',refund=False,**extra):
        return call('paws_star_refunded' if refund else 'paws_star_paid',**dict(dict(p_user=42,p_order=o['id'],p_currency='XTR',p_amount=100,p_charge=charge),**extra))

    def test_stars_prices_and_no_credit_before_success(self):
        self.assertEqual([(p['stars'],p['bones']) for p in call('paws_star_catalog',p_user=42)['packages']],[(100,10000),(250,30000),(500,80000),(1000,200000)])
        o=self.order();self.assertEqual(o,self.order());self.checkout(o);self.checkout(o)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        self.assertFalse(call('paws_star_status',p_user=42,p_order=o['id'])['paid'])
        for extra in [dict(p_user=43),dict(p_currency='RUB'),dict(p_amount=1),dict(p_query='different')]:
            with self.assertRaises(AssertionError):self.checkout(o,**extra)
        with self.assertRaises(AssertionError):call('paws_star_status',p_user=43,p_order=o['id'])

    def test_stars_success_and_concurrent_replay_once(self):
        from concurrent.futures import ThreadPoolExecutor
        o=self.order();self.checkout(o)
        sql("update paws.star_orders set expires_at=clock_timestamp()-interval '1 hour'")
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:self.payment(o),range(4)))
        self.assertEqual(sum(bool(r['credited']) for r in results),1)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],10000)
        self.assertTrue(call('paws_star_status',p_user=42,p_order=o['id'])['paid'])
        for extra in [dict(p_user=43),dict(p_amount=250),dict(p_currency='USD')]:
            with self.assertRaises(AssertionError):self.payment(o,**extra)
        o2=self.order('second')
        with self.assertRaises(AssertionError):self.payment(o2,charge='without_checkout')
        self.checkout(o2)
        with self.assertRaises(AssertionError):self.payment(o2)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],10000)

    def test_stars_refund_debt_and_future_credit(self):
        o=self.order();self.checkout(o);self.payment(o)
        sql('update paws.wallets set balance=2000 where owner_id=42')
        self.assertTrue(self.payment(o,refund=True)['changed'])
        self.assertFalse(self.payment(o,refund=True)['changed'])
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        self.assertEqual(call('paws_star_catalog',p_user=42)['debt'],8000)
        self.assertFalse(self.payment(o)['credited'])
        o2=self.order('new');self.checkout(o2);self.payment(o2,charge='charge2')
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],2000)
        self.assertEqual(call('paws_star_catalog',p_user=42)['debt'],0)

    def test_stars_refund_before_payment_and_order_binding(self):
        o=self.order();self.checkout(o);self.payment(o,refund=True)
        self.assertFalse(self.payment(o)['credited'])
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        o2=self.order('another');self.checkout(o2)
        with self.assertRaises(AssertionError):self.payment(o2)
        self.assertEqual(sql('select count(*) from paws.star_payments'),'1')

    def test_reminders_local_time_strict_48h_dedup_and_optout(self):
        now='2026-11-06 06:00:00+00'
        result=call('paws_activity',p_user=42,p_timezone='Europe/Kaliningrad');self.assertTrue(result['enabled'])
        sql("update paws.activity set last_seen='2026-11-04 06:00:00+00'")
        self.assertEqual(call('paws_reminders_generate',p_now=now)['queued'],0)
        sql("update paws.activity set last_seen=last_seen-interval '1 second'")
        self.assertEqual(call('paws_reminders_generate',p_now=now)['queued'],1)
        self.assertEqual(call('paws_reminders_generate',p_now=now)['queued'],0)
        self.assertEqual(len(call('paws_reminders_claim',p_now=now)['messages']),1)
        self.assertEqual(call('paws_reminders_claim',p_now=now)['messages'],[])
        self.assertEqual(call('paws_reminders_generate',p_now='2026-11-06 16:00:00+00')['queued'],1)
        self.assertEqual(call('paws_reminders_generate',p_now='2026-11-07 06:16:00+00')['queued'],0)
        call('paws_reminders_set',p_user=42,p_enabled='false')
        sql("update paws.activity set last_seen='2026-11-01'")
        self.assertEqual(call('paws_reminders_generate',p_now='2026-11-07 06:00:00+00')['queued'],0)
        self.assertEqual(call('paws_reminders_claim',p_now='2026-11-06 16:00:00+00')['messages'],[])
        self.assertFalse(call('paws_activity',p_user=42,p_timezone='America/New_York')['enabled'])
        with self.assertRaises(AssertionError):call('paws_activity',p_user=42,p_timezone='fake/zone')

    def test_reminders_timezone_dst_return_and_missing_timezone(self):
        self.seller()
        call('paws_activity',p_user=42,p_timezone='America/New_York')
        call('paws_activity',p_user=43)
        sql("update paws.activity set last_seen='2026-10-01'")
        self.assertEqual(call('paws_reminders_generate',p_now='2026-10-31 12:00:00+00')['queued'],1)
        self.assertEqual(call('paws_reminders_generate',p_now='2026-11-06 12:00:00+00')['queued'],0)
        self.assertEqual(call('paws_reminders_generate',p_now='2026-11-06 13:00:00+00')['queued'],1)
        call('paws_activity',p_user=42)
        self.assertEqual(call('paws_reminders_claim',p_now='2026-11-06 13:00:00+00')['messages'],[])

    def test_largest_territory_and_empty_owner(self):
        self.assertEqual(sql('select public.paws_largest_territory(42,43) is null'),'t')
        self.fund();a=self.buy(self.purchase_vertices(width=.0001))
        b=self.buy(self.purchase_vertices(x=20.01,width=.0003))
        largest=call('paws_largest_territory',p_user=99,p_pet=42)
        self.assertEqual(largest['id'],b['id']);self.assertGreater(largest['area'],a['area'])
        self.assertEqual(largest['geometry']['type'],'MultiPolygon')

    def test_stars_and_reminder_service_only(self):
        for query in ["select public.paws_star_catalog(42)","select * from paws.star_orders","select public.paws_reminders_generate()","select public.paws_largest_territory(42,42)"]:
            self.assertNotEqual(sql('set role anon;'+query,check=False).returncode,0)


if __name__=='__main__':unittest.main()
