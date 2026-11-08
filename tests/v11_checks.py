"""Одноразовая PostGIS: v.1.1, общие аккаунты, один трек, Stars и прежние правила."""
import unittest,time,uuid,hashlib,json
from concurrent.futures import ThreadPoolExecutor
import v10_checks
from postgis_checks import call,sql,ROOT,literal
MIGRATION=ROOT/'supabase/migrations/202611080001_v11.sql'

class V11Checks(v10_checks.V10Checks):
    def setUp(self):
        sql('truncate paws.account_invites,paws.account_links,paws.hq_upgrades,paws.headquarters,paws.star_refunds,paws.star_payments,paws.star_orders,paws.star_debts,paws.payment_issues,paws.payment_support,paws.reminder_messages,paws.activity,paws.notifications,paws.purchases,paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397c63')

    def invite(self,actor=88,hash_value=None):
        h=hash_value or hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        call('paws_account_invite',p_user=42,p_username='second_general',p_hash=h)
        return h
    def link(self,actor=88):
        h=self.invite();call('paws_account_accept',p_user=actor,p_username='SECOND_GENERAL',p_hash=h);return h
    def shared(self,actor,p,update=1,message=77,initial=True):
        return call('paws_live_receive_shared',p_actor=actor,p_message=message,p_update=update,p_timestamp=p['timestamp'],p_sent_at=p.get('sent_at',p['timestamp']),p_longitude=p['longitude'],p_latitude=p['latitude'],p_accuracy=p['accuracy'],p_period=3600,p_initial=initial)

    def test_shared_account_identity_owner_only_controls_and_no_profile_overwrite(self):
        h=self.link()
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'42')
        self.assertEqual(call('paws_accounts',p_user=88)['role'],'secondary')
        self.assertEqual(call('paws_account_accept',p_user=88,p_username='second_general',p_hash=h)['primaryId'],'42')
        for name,args in [('paws_account_invite',dict(p_username='other_general',p_hash='c'*64)),('paws_account_remove',{}),('paws_save_pet',dict(p_name='Другой',p_age=2,p_description='',p_color='#123456'))]:
            with self.assertRaises(AssertionError):call(name,p_user=88,**args)
        self.assertEqual(sql('select count(*) from paws.pets'),'1')
        call('paws_account_remove',p_user=42)
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'88')
        with self.assertRaises(AssertionError):call('paws_account_accept',p_user=88,p_username='second_general',p_hash=h)

    def test_invite_username_expiry_rotation_existing_pet_and_service_only(self):
        h=self.invite()
        for actor,username in [(88,'wrong_name'),(42,'second_general')]:
            with self.assertRaises(AssertionError):call('paws_account_accept',p_user=actor,p_username=username,p_hash=h)
        self.seller()
        with self.assertRaises(AssertionError):call('paws_account_accept',p_user=43,p_username='second_general',p_hash=h)
        new=self.invite(hash_value='b'*64)
        with self.assertRaises(AssertionError):call('paws_account_accept',p_user=88,p_username='second_general',p_hash=h)
        sql("update paws.account_invites set expires_at=clock_timestamp()-interval '1 second'")
        with self.assertRaises(AssertionError):call('paws_account_accept',p_user=88,p_username='second_general',p_hash=new)
        for signature in ['paws_account_resolve(bigint)','paws_accounts(bigint)','paws_account_accept(bigint,text,text)','paws_live_capture_shared(bigint)']:
            self.assertEqual(sql(f"select has_function_privilege('anon','public.{signature}','execute')"),'f')

    def test_only_one_secondary_and_concurrent_acceptance(self):
        h=self.invite()
        def attempt(actor):
            try:return call('paws_account_accept',p_user=actor,p_username='second_general',p_hash=h)
            except AssertionError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(attempt,[88,89]))
        self.assertEqual(sum(x is not None for x in r),1)
        self.assertEqual(sql('select count(*) from paws.account_links'),'1')
        with self.assertRaises(AssertionError):self.invite()

    def test_long_gps_gaps_are_accepted_in_recording_and_final_capture(self):
        points=self.points([(0,0),(.0003,0),(.0003,.0003),(0,.0003),(0,0)])
        end=time.time()-1
        for i,p in enumerate(points):p['timestamp']=end-120*(4-i)
        walk=self.walk(True)
        for i,p in enumerate(points):
            result=call('paws_live_point',p_user=42,p_message=77,p_update=i+1,p_timestamp=p['timestamp'],p_longitude=p['longitude'],p_latitude=p['latitude'],p_accuracy=20,p_period=3600)
            self.assertTrue(result['accepted'])
        self.assertGreater(call('paws_live_capture',p_user=42)['area'],25)

    def test_two_accounts_or_messages_cannot_mix_streams_or_capture_from_other_account(self):
        self.link();p={'longitude':20,'latitude':54,'accuracy':20,'timestamp':time.time()-1}
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda actor:self.shared(actor,p),[42,88]))
        self.assertEqual(sum(x['accepted'] for x in r),1)
        self.assertIn('other_account',[x.get('reason') for x in r])
        winner=[42,88][next(i for i,x in enumerate(r)if x['accepted'])];loser=88 if winner==42 else 42
        self.assertEqual(sql('select count(*) from paws.walks where active'),'1')
        self.assertEqual(self.shared(winner,{**p,'timestamp':time.time()},update=2,message=78)['reason'],'other_message')
        self.assertFalse(call('paws_live_status_shared',p_actor=loser)['walk']['trackingByMe'])
        with self.assertRaisesRegex(AssertionError,'начал трансляцию'):call('paws_live_capture_shared',p_actor=loser)
        self.assertEqual(sql('select jsonb_array_length(points) from paws.live_walks'),'1')

    def test_secondary_completes_its_own_stream_for_the_shared_pet(self):
        self.link();walk=self.walk(True)
        # Сдвиг времени заменяет реальное ожидание прогулки в локальном тесте.
        sql(f"update paws.live_walks set actor_id=88 where walk_id={literal(walk)}")
        points=self.timed(4)
        for i,p in enumerate(points):
            self.assertTrue(self.shared(88,{**p,'sent_at':points[0]['timestamp']},update=i+1,initial=False)['accepted'])
        result=call('paws_live_capture_shared',p_actor=88)
        self.assertGreater(result['area'],25)
        self.assertGreater(call('paws_me',p_user=42)['area'],25)
        self.assertIsNone(call('paws_me',p_user=88)['pet'])
        self.assertEqual(call('paws_live_capture_shared',p_actor=88),result)
        self.assertEqual(sql('select count(*) from paws.notifications'),'0')

    def test_profile_creation_racing_with_link_cannot_make_two_pets(self):
        h=self.invite()
        def attempt(kind):
            try:
                if kind=='link':return call('paws_account_accept',p_user=88,p_username='second_general',p_hash=h)
                return call('paws_save_pet',p_user=88,p_name='Другой',p_age=2,p_description='',p_color='#123456')
            except AssertionError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,['link','profile']))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertFalse(sql('select exists(select 1 from paws.account_links where actor_id=88)')=='t' and sql('select exists(select 1 from paws.pets where owner_id=88)')=='t')

    def test_unlink_cancels_secondary_walk_and_revokes_access(self):
        self.link();p={'longitude':20,'latitude':54,'accuracy':20,'timestamp':time.time()-1}
        self.assertTrue(self.shared(88,p)['accepted'])
        call('paws_account_remove',p_user=42)
        self.assertEqual(sql('select count(*) from paws.walks where active'),'0')
        self.assertEqual(sql('select points from paws.live_walks'),'[]')
        self.assertEqual(call('paws_live_status_shared',p_actor=88)['walk'],None)

    def test_stars_payer_and_target_are_frozen_through_unlink_and_refund(self):
        self.link();package=sql('select id from paws.star_packages where stars=100')
        order=call('paws_star_order',p_user=88,p_package=package,p_request='secondary-pays')
        self.assertEqual(sql('select owner_id||\':\'||payer_id from paws.star_orders'),'42:88')
        with self.assertRaises(AssertionError):call('paws_star_checkout',p_user=42,p_order=order['id'],p_currency='XTR',p_amount=100,p_query='wrong-payer')
        call('paws_star_checkout',p_user=88,p_order=order['id'],p_currency='XTR',p_amount=100,p_query='ok-payer')
        call('paws_account_remove',p_user=42)
        args=dict(p_user=88,p_order=order['id'],p_currency='XTR',p_amount=100,p_charge='shared-charge')
        self.assertTrue(call('paws_star_paid',**args)['credited'])
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],10000)
        self.assertFalse(call('paws_star_paid',**args)['credited'])
        call('paws_star_refunded',**args)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        self.assertEqual(sql('select count(*) from paws.pets'),'1')

    def test_migration_does_not_reset_balance(self):
        self.fund();self.link();call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        before=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        sql(MIGRATION.read_text())
        self.assertEqual(before,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))
        self.assertEqual(call('paws_hq',p_user=42)['level'],2)
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'42')
        self.assertTrue(call('paws_capabilities')['unlimitedGpsGap'])

    def test_z_upgrade_preserves_legacy_income_once(self):
        super().test_z_upgrade_preserves_legacy_income_once()
        sql(MIGRATION.read_text())

if __name__=='__main__':unittest.main()
