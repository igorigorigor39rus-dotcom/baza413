"""Только одноразовый Docker PostGIS после базовой + единой миграции v.0.5."""
import unittest
import v04_checks
from postgis_checks import sql,call,route,literal,ROOT


class V05Checks(v04_checks.V04Checks):
    def setUp(self):
        sql('truncate paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Агент',p_age=3,p_description='Досье',p_color='#397C63')

    def live(self,accuracy=15):
        walk=call('paws_live_start',p_user=42,p_accuracy=accuracy)['walk']['id']
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '120 seconds' where id={literal(walk)}")
        return walk

    def point(self,p,i,message=77,accuracy='use'):
        return call('paws_live_point',p_user=42,p_message=message,p_update=i,p_timestamp=p['timestamp'],
                    p_longitude=p['longitude'],p_latitude=p['latitude'],p_accuracy=p['accuracy'] if accuracy=='use' else accuracy,p_period=3600)

    def test_closure_15m_and_accuracy_15(self):
        self.live();points=route(width=.0002,height=.0002)
        points[-1]['latitude']+=.00013 # около 14.5 м от старта, прежде не проходило
        for i,p in enumerate(points):self.assertTrue(self.point({**p,'accuracy':15},i+1)['accepted'])
        result=call('paws_live_capture',p_user=42)
        self.assertGreater(result['area'],25)
        self.assertEqual(call('paws_live_capture',p_user=42)['id'],result['id'])
        self.assertEqual(sql("select points from paws.live_walks"),'[]')
        self.assertIsNone(call('paws_live_status',p_user=42)['walk'])

    def test_closure_beyond15_rejected(self):
        self.live();points=route(width=.0002,height=.0002);points[-1]['latitude']+=.00016
        for i,p in enumerate(points):self.point(p,i+1)
        with self.assertRaises(AssertionError):call('paws_live_capture',p_user=42)

    def test_bad_signal_duplicate_binding_and_gap(self):
        with self.assertRaises(AssertionError):self.live(15.01)
        self.live();points=route(width=.0002,height=.0002)
        self.assertFalse(self.point(points[0],1,accuracy=16)['accepted'])
        self.assertTrue(self.point(points[0],2)['accepted'])
        self.assertFalse(self.point(points[1],2)['accepted']) # повтор update
        self.assertFalse(self.point(points[1],3,message=88)['accepted'])
        bad={**points[1],'timestamp':points[0]['timestamp']+46}
        self.assertEqual(self.point(bad,4)['reason'],'gap')
        with self.assertRaises(AssertionError):call('paws_live_capture',p_user=42)
        call('paws_live_cancel',p_user=42)
        self.assertEqual(sql('select points from paws.live_walks'),'[]')

    def test_foreground_cancel_clears_live_buffer(self):
        walk=self.live();self.point(route(width=.0002,height=.0002)[0],1)
        call('paws_cancel',p_user=42,p_walk=walk)
        self.assertEqual(sql('select points from paws.live_walks'),'[]')
        self.assertEqual(sql("select has_function_privilege('anon','public.paws_live_capture(bigint)','execute')"),'f')

    def test_top_ten_order_and_readonly(self):
        for user in range(100,112):
            call('paws_save_pet',p_user=user,p_name=f'Агент {user}',p_age=3,p_description='',p_color='#397C63')
            sql(f'insert into paws.wallets(owner_id,balance) values({user},{user-100})')
        agents=call('paws_top',p_user=42)['agents']
        self.assertEqual([int(a['pet']['id']) for a in agents],list(range(111,101,-1)))
        self.assertEqual(len(agents),10)
        self.assertEqual(sql("select has_function_privilege('anon','public.paws_top(bigint)','execute')"),'f')

    def test_expired_live_cleanup(self):
        walk=self.live();self.point(route(width=.0002,height=.0002)[0],1)
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '3 hours' where id={literal(walk)}")
        self.assertIsNone(call('paws_live_status',p_user=42)['walk'])
        self.assertEqual(sql('select points from paws.live_walks'),'[]')

    def test_migration_does_not_reset_balance(self):
        self.land();sql('update paws.wallets set balance=123 where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060003_v05.sql').read_text())
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'123')
        self.assertTrue(call('paws_capabilities')['liveTracking'])


if __name__=='__main__':unittest.main()
