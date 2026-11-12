"""Завершение Telegram-прогулки: только одноразовая локальная PostGIS.

Сначала установите базовую SQL, накопительную v111, efficient_sync и исправление
202611120001_live_completion.sql и 202611130001_unlimited_walks.sql.
Рабочий Supabase тесты не используют.
"""
import time
import json
import math
import unittest
from concurrent.futures import ThreadPoolExecutor

from postgis_checks import call, literal, sql, ROOT
import v111_checks


class LiveCompletionChecks(unittest.TestCase):
    def setUp(self):
        self.game = v111_checks.V111Checks()
        self.game.setUp()

    def recorded_route(self, age=90, speed=4, closed=True):
        walk = self.game.walk(True)
        points = self.game.timed(speed)
        for point in points:
            point['timestamp'] -= age
        if not closed:
            points[-1]['latitude'] += .0004  # Конец дальше 20 м от старта.
        for i, point in enumerate(points):
            result = self.game.shared(42, {**point, 'sent_at': points[0]['timestamp']},
                                      update=i + 1, initial=False)
            self.assertTrue(result['accepted'], result)
        return walk, points

    def test_closed_recorded_route_can_finish_between_telegram_updates(self):
        for age in (90, 240):
            with self.subTest(age=age):
                self.setUp()
                self.recorded_route(age=age)
                result = call('paws_live_capture_shared', p_actor=42)
                self.assertGreater(result['area'], 25)
                self.assertEqual(call('paws_live_capture_shared', p_actor=42), result)
                self.assertEqual(sql('select count(*) from paws.territories'), '1')

    def test_simultaneous_capture_retries_return_one_territory(self):
        self.recorded_route()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: call('paws_live_capture_shared', p_actor=42), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(sql('select count(*) from paws.territories'), '1')

    def test_diagnostic_probe_rolls_back_success_and_failure(self):
        def snapshot():
            return sql("select jsonb_build_object('walks',(select jsonb_agg(to_jsonb(w)) from paws.walks w),'live',(select jsonb_agg(to_jsonb(l)) from paws.live_walks l),'land',(select jsonb_agg(to_jsonb(t)) from paws.territories t),'wallets',(select jsonb_agg(to_jsonb(w)) from paws.wallets w),'revision',(select jsonb_agg(to_jsonb(r)) from paws.sync_revision r))")
        for closed in (True, False):
            with self.subTest(closed=closed):
                self.setUp()
                self.recorded_route(closed=closed)
                before = snapshot()
                result = json.loads(sql((ROOT / 'guide/CAPTURE_DIAGNOSTICS.sql').read_text()))
                self.assertTrue(result['rolled_back'])
                self.assertEqual(result['status'], 'capture_succeeded_in_dry_run' if closed else 'capture_failed')
                if not closed:
                    self.assertEqual(result['code'], 'P0001')
                self.assertEqual(snapshot(), before)

    def test_open_route_stays_active_and_can_finish_after_next_update(self):
        walk, points = self.recorded_route(closed=False)
        with self.assertRaisesRegex(AssertionError, 'Контур открыт'):
            call('paws_live_capture_shared', p_actor=42)
        self.assertEqual(sql('select active from paws.walks where id=' + literal(walk)), 't')
        point = {**points[0], 'timestamp': time.time(), 'sent_at': points[0]['timestamp']}
        self.assertTrue(self.game.shared(42, point, update=6, initial=False)['accepted'])
        self.assertGreater(call('paws_live_capture_shared', p_actor=42)['area'], 25)

    def test_unrecorded_points_still_require_fresh_gps(self):
        walk, points = self.recorded_route()
        points[-1]['longitude'] += .000001  # Этой точки не было в webhook.
        with self.assertRaisesRegex(AssertionError, 'Нет свежего GPS'):
            call('paws_capture', p_user=42, p_walk=walk, p_points=points)
        self.assertEqual(sql('select count(*) from paws.territories'), '0')

    def test_stopped_and_expired_broadcasts_can_finish_recorded_closed_route(self):
        for column in ('broadcast_stopped=true', "broadcast_until=clock_timestamp()-interval '1 second'"):
            with self.subTest(column=column):
                self.setUp()
                self.recorded_route()
                sql('update paws.live_walks set ' + column)
                result = call('paws_live_capture_shared', p_actor=42)
                self.assertGreater(result['area'], 25)
                self.assertEqual(call('paws_live_capture_shared', p_actor=42), result)
                self.assertEqual(sql('select count(*) from paws.territories'), '1')

    def test_old_recorded_route_does_not_bypass_speed_limit(self):
        self.recorded_route(age=90, speed=25)
        result = call('paws_live_capture_shared', p_actor=42)
        self.assertTrue(result['annulled'])
        self.assertEqual(result['code'], 'SPEED_LIMIT')
        self.assertEqual(sql('select count(*) from paws.territories'), '0')

    def test_secondary_can_finish_its_stream_but_primary_cannot(self):
        self.game.link()
        self.recorded_route()
        sql('update paws.live_walks set actor_id=88')
        with self.assertRaisesRegex(AssertionError, 'начал трансляцию'):
            call('paws_live_capture_shared', p_actor=42)
        self.assertGreater(call('paws_live_capture_shared', p_actor=88)['area'], 25)

    def test_old_recorded_walk_survives_sync_and_cleanup_and_can_finish(self):
        walk, _ = self.recorded_route()
        sql("update paws.walks set started_at=clock_timestamp()-interval '3 days' where id=" + literal(walk))
        sql("update paws.live_walks set broadcast_stopped=true,broadcast_until=clock_timestamp()-interval '1 day',points=(select jsonb_agg(p||jsonb_build_object('timestamp',(p->>'timestamp')::float8-86400)) from jsonb_array_elements(points) p)")
        snapshot = call('paws_sync', p_actor=42, p_timezone='UTC')
        self.assertEqual(snapshot['live']['walk']['id'], walk)
        sql('select paws.live_cleanup()')
        self.assertEqual(sql('select active from paws.walks where id=' + literal(walk)), 't')
        self.assertGreater(call('paws_live_capture_shared', p_actor=42)['area'], 25)

    def test_reported_209_point_stopped_walk_finishes_after_three_hours(self):
        walk = self.game.walk(True)
        started = time.time() - (3 * 3600 + 29 * 60)
        sql(f'update paws.walks set started_at=to_timestamp({started}) where id={literal(walk)}')
        queries = []
        for i in range(209):
            angle = 2 * math.pi * i / 208
            lon, lat = 20 + .0004 * math.cos(angle), 54 + .0004 * math.sin(angle)
            queries.append(f'select public.paws_live_point(42,77,{i+1},{started+1+i*900/208},{lon},{lat},10,3600);')
        self.assertTrue(all(json.loads(row)['accepted'] for row in sql(''.join(queries)).splitlines()))
        sql("update paws.live_walks set broadcast_stopped=true,broadcast_until=clock_timestamp()-interval '2 hours'")
        self.assertEqual(call('paws_sync', p_actor=42, p_timezone='UTC')['live']['walk']['pointCount'], 209)
        self.assertGreater(call('paws_live_capture_shared', p_actor=42)['area'], 25)

    def test_another_player_start_cannot_delete_old_active_walk(self):
        walk, _ = self.recorded_route()
        sql("update paws.walks set started_at=clock_timestamp()-interval '3 days' where id=" + literal(walk))
        call('paws_save_pet', p_user=43, p_name='Другой', p_age=2, p_description='', p_color='#397c63')
        call('paws_live_start', p_user=43, p_accuracy=10)
        self.assertEqual(sql('select active from paws.walks where id=' + literal(walk)), 't')
        self.assertEqual(sql('select jsonb_array_length(points) from paws.live_walks where walk_id=' + literal(walk)), '5')

    def test_recording_continues_beyond_two_hours(self):
        walk = self.game.walk(True)
        end = time.time() - 1
        started = end - 4 * 3600
        sql(f'update paws.walks set started_at=to_timestamp({started}) where id={literal(walk)}')
        points = self.game.points([(0, 0), (.0003, 0), (.0003, .0003), (0, .0003), (0, 0)])
        for i, point in enumerate(points):
            point['timestamp'] = started + i * 3600
            self.assertTrue(self.game.shared(42, {**point, 'sent_at': started}, update=i + 1, initial=False)['accepted'])
        self.assertEqual(call('paws_live_status_shared', p_actor=42)['walk']['id'], walk)
        self.assertGreater(call('paws_live_capture_shared', p_actor=42)['area'], 25)

    def test_stopped_open_route_and_cancelled_route_cannot_finish(self):
        walk, _ = self.recorded_route(closed=False)
        sql('update paws.live_walks set broadcast_stopped=true')
        with self.assertRaisesRegex(AssertionError, 'Контур открыт'):
            call('paws_live_capture_shared', p_actor=42)
        call('paws_live_cancel', p_user=42)
        with self.assertRaisesRegex(AssertionError, 'отменена'):
            call('paws_live_capture_shared', p_actor=42)
        self.assertEqual(sql('select count(*) from paws.territories'), '0')

    def test_accurate_points_only_and_other_device_cannot_append(self):
        self.game.link()
        _, points = self.recorded_route()
        candidate = {**points[-1], 'timestamp': time.time(), 'sent_at': points[0]['timestamp']}
        self.assertEqual(self.game.shared(88, candidate, update=6, initial=False)['reason'], 'other_account')
        self.assertEqual(self.game.shared(42, {**candidate, 'accuracy': 21}, update=7, initial=False)['reason'], 'accuracy')
        self.assertEqual(sql('select jsonb_array_length(points) from paws.live_walks'), '5')

    def test_incremental_migration_preserves_data_and_capabilities(self):
        self.game.fund()
        self.recorded_route()
        before = sql('select points from paws.live_walks')
        wallet = sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        flags = call('paws_capabilities')
        sql((ROOT / 'supabase/migrations/202611130001_unlimited_walks.sql').read_text())
        self.assertEqual(sql('select points from paws.live_walks'), before)
        self.assertEqual(sql('select row_to_json(w) from paws.wallets w where owner_id=42'), wallet)
        self.assertEqual(call('paws_capabilities'), flags)
        self.assertTrue(flags['storedLiveCompletion'])
        self.assertTrue(flags['efficientSync'])
        self.assertTrue(flags['unlimitedWalkDuration'])
        self.assertTrue(flags['recordedFinishAfterStop'])
        for role in ('anon', 'authenticated'):
            for signature in ('public.paws_capture(bigint,uuid,jsonb)', 'public.paws_live_capture(bigint)', 'public.paws_start(bigint)', 'paws.live_cleanup()', 'public.paws_sync(bigint,uuid,integer,text,bigint,text,text,text)'):
                self.assertEqual(sql(f"select has_function_privilege('{role}','{signature}','execute')"), 'f')


if __name__ == '__main__':
    unittest.main()
