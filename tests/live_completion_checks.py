"""Завершение Telegram-прогулки: только одноразовая локальная PostGIS.

Сначала установите базовую SQL, накопительную v111, efficient_sync и исправление
202611120001_live_completion.sql. Рабочий Supabase тесты не используют.
"""
import time
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

    def test_stopped_and_expired_broadcasts_cannot_finish(self):
        for column in ('broadcast_stopped=true', "broadcast_until=clock_timestamp()-interval '1 second'"):
            with self.subTest(column=column):
                self.setUp()
                self.recorded_route()
                sql('update paws.live_walks set ' + column)
                with self.assertRaisesRegex(AssertionError, 'Включите трансляцию'):
                    call('paws_live_capture_shared', p_actor=42)
                self.assertEqual(sql('select count(*) from paws.territories'), '0')

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

    def test_two_hour_limit_remains(self):
        walk, _ = self.recorded_route()
        sql("update paws.walks set started_at=clock_timestamp()-interval '2 hours 1 second' where id=" + literal(walk))
        with self.assertRaisesRegex(AssertionError, 'Включите трансляцию'):
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
        sql((ROOT / 'supabase/migrations/202611120001_live_completion.sql').read_text())
        self.assertEqual(sql('select points from paws.live_walks'), before)
        self.assertEqual(sql('select row_to_json(w) from paws.wallets w where owner_id=42'), wallet)
        self.assertEqual(call('paws_capabilities'), flags)
        self.assertTrue(flags['storedLiveCompletion'])
        self.assertTrue(flags['efficientSync'])
        for role in ('anon', 'authenticated'):
            self.assertEqual(sql(f"select has_function_privilege('{role}','public.paws_capture(bigint,uuid,jsonb)','execute')"), 'f')


if __name__ == '__main__':
    unittest.main()
