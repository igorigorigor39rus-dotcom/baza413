"""Одноразовая PostGIS с модулем safeupdate: повтор ошибки 21000 и исправление.

Нужны bootstrap, базовая SQL, v111, efficient_sync, live_completion и
unlimited_walks. safeupdate.so должен быть установлен в libdir PostgreSQL.
Защита загружается только в проверяемых сессиях; подготовка данных — отдельно.
Не запускать на рабочем Supabase.
"""
import json
import unittest

import live_completion_checks
from postgis_checks import ROOT, sql, call

PATCH = ROOT / 'supabase/migrations/202611160001_sync_revision_where.sql'


def guarded(query, check=True):
    return sql("\\set VERBOSITY verbose\nload 'safeupdate';\n" + query, check=check)


class SafeUpdateChecks(unittest.TestCase):
    def setUp(self):
        sql(PATCH.read_text())
        self.game = live_completion_checks.LiveCompletionChecks()
        self.game.setUp()

    def test_previous_trigger_fails_21000_and_fix_finishes_same_walk(self):
        walk, _ = self.game.recorded_route()
        old = (ROOT / 'supabase/migrations/202611100001_efficient_sync.sql').read_text()
        start = old.index('create or replace function paws.bump_sync_revision(')
        end = old.index('end $$;', start) + len('end $$;')
        sql(old[start:end])
        points_before = sql('select points from paws.live_walks')
        result = guarded('select public.paws_live_capture_shared(42);', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('21000', result.stderr)
        self.assertIn('UPDATE requires a WHERE clause', result.stderr)
        self.assertIn('bump_sync_revision', result.stderr)
        self.assertEqual(sql('select points from paws.live_walks'), points_before)
        self.assertEqual(sql('select count(*) from paws.territories'), '0')
        sql(PATCH.read_text())
        captured = json.loads(guarded('set role service_role;select public.paws_live_capture_shared(42);'))
        self.assertGreater(captured['area'], 25)
        self.assertEqual(captured, json.loads(guarded('set role service_role;select public.paws_live_capture_shared(42);')))
        self.assertEqual(sql('select count(*) from paws.territories'), '1')

    def test_guard_still_blocks_unqualified_updates(self):
        result = guarded('update paws.sync_revision set revision=revision+1;', check=False)
        self.assertIn('21000', result.stderr)
        self.assertIn('UPDATE requires a WHERE clause', result.stderr)
        self.assertEqual(guarded("select current_setting('safeupdate.enabled');"), 'on')

    def test_capture_updates_existing_land_and_profile_with_guard(self):
        self.game.recorded_route()
        guarded('select public.paws_live_capture_shared(42);')
        sql("update paws.territories set geom=ST_Multi(ST_Expand(geom,.0001)),area=ST_Area(ST_Expand(geom,.0001)::geography) where owner_id=42")
        # Те же координаты пересекают существующую территорию: выполняется
        # UPDATE/DELETE старого участка и INSERT нового, оба вызывают триггер.
        self.game.recorded_route()
        before = int(sql('select revision from paws.sync_revision where id=true'))
        second = json.loads(guarded('select public.paws_live_capture_shared(42);'))
        self.assertGreater(second['area'], 25)
        self.assertGreater(int(sql('select revision from paws.sync_revision where id=true')), before)
        guarded("update paws.pets set description='Проверено' where owner_id=42;")
        self.assertEqual(sql('select description from paws.pets where owner_id=42'), 'Проверено')

    def test_migration_preserves_data_permissions_and_current_revision(self):
        self.game.recorded_route()
        self.game.game.fund()
        before = sql("select jsonb_build_object('points',(select points from paws.live_walks),'wallet',(select row_to_json(w) from paws.wallets w where owner_id=42),'revision',(select revision from paws.sync_revision where id=true))")
        guarded(PATCH.read_text())
        after = sql("select jsonb_build_object('points',(select points from paws.live_walks),'wallet',(select row_to_json(w) from paws.wallets w where owner_id=42),'revision',(select revision from paws.sync_revision where id=true))")
        self.assertEqual(before, after)
        self.assertTrue(call('paws_capabilities')['safeSyncRevision'])
        self.assertEqual(sql("select has_function_privilege('anon','paws.bump_sync_revision()','execute')"), 'f')
        self.assertEqual(sql("select has_function_privilege('authenticated','paws.bump_sync_revision()','execute')"), 'f')


if __name__ == '__main__':
    unittest.main()
