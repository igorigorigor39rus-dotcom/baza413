"""Одноразовая PostGIS: v.1.0, породы, штаб и все правила v.0.9."""
import unittest,uuid,json
from concurrent.futures import ThreadPoolExecutor
import v09_checks
from postgis_checks import call,sql,ROOT

class V10Checks(v09_checks.V09Checks):
    def setUp(self):
        sql('truncate paws.hq_upgrades,paws.headquarters,paws.star_refunds,paws.star_payments,paws.star_orders,paws.star_debts,paws.payment_issues,paws.payment_support,paws.reminder_messages,paws.activity,paws.notifications,paws.purchases,paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397c63')

    def test_hq_all_nine_prices_total_and_max_progress(self):
        hq=call('paws_hq',p_user=42);self.assertEqual((hq['level'],hq['progress'],hq['nextCost']),(1,0,100000))
        sql('insert into paws.wallets(owner_id,balance) values(42,51100000)')
        total=0
        for lv in range(1,10):
            result=call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=lv)
            self.assertEqual(result['cost'],100000*2**(lv-1));total+=result['cost']
            self.assertEqual(result['headquarters']['level'],lv+1)
        self.assertEqual(total,51100000);self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        hq=call('paws_hq',p_user=42);self.assertEqual(hq['progress'],100);self.assertIsNone(hq['nextCost']);self.assertFalse(hq['affordable'])
        with self.assertRaises(AssertionError):call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=10)

    def test_hq_insufficient_pending_and_stale_level_never_charge(self):
        self.daily_seed(area=2000000,hours=12,balance=99999)
        pending=call('paws_wallet',p_user=42);self.assertGreaterEqual(pending['pending'],100000)
        with self.assertRaises(AssertionError):call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],99999)
        self.assertEqual(call('paws_hq',p_user=42)['level'],1)
        self.fund();call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        before=call('paws_wallet',p_user=42)['balance']
        with self.assertRaises(AssertionError):call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],before)

    def test_hq_concurrent_retry_and_distinct_requests(self):
        self.fund();request=str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:call('paws_hq_upgrade',p_user=42,p_request=request,p_level=1),range(4)))
        self.assertTrue(all(r==results[0] for r in results));self.assertEqual(call('paws_wallet',p_user=42)['balance'],900000)
        self.assertEqual(sql('select count(*) from paws.hq_upgrades'),'1')
        self.assertEqual(call('paws_hq',p_user=42)['level'],2)
        def race(_):
            try:return call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=2)
            except AssertionError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(race,range(2)))
        self.assertEqual(sum(r is not None for r in results),1);self.assertEqual(call('paws_wallet',p_user=42)['balance'],700000)

    def test_breed_saves_atomically_custom_and_invalid_ids(self):
        breed=sql("select id from paws.breeds where family='spitz' order by id limit 1")
        args=dict(p_user=42,p_name='Луна',p_age=2,p_description='',p_color='#397c63',p_hue=150,p_saturation=55,p_opacity=.35,p_pattern='digital',p_breed=breed)
        pet=call('paws_save_general',**args)['pet'];self.assertEqual(pet['breedId'],breed);self.assertEqual(pet['breedFamily'],'spitz')
        with self.assertRaises(AssertionError):call('paws_save_general',**{**args,'p_breed':'not-breed','p_name':'Потерянное имя'})
        self.assertEqual(call('paws_me',p_user=42)['pet']['name'],'Луна')
        pet=call('paws_save_general',**{**args,'p_breed':'custom'},p_custom='Редкая порода')['pet'];self.assertEqual(pet['breedName'],'Редкая порода')
        with self.assertRaises(AssertionError):call('paws_save_general',**{**args,'p_breed':'custom'},p_custom='')
        self.assertGreater(int(sql('select count(*) from paws.breeds')),500)

    def test_hq_service_only_and_other_player_state(self):
        self.seller();self.assertEqual(call('paws_hq',p_user=43)['level'],1)
        self.fund();call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        self.assertEqual(call('paws_hq',p_user=43)['level'],1)
        for signature in ['paws_hq(bigint)','paws_hq_upgrade(bigint,uuid,integer)']:
            self.assertEqual(sql(f"select has_function_privilege('anon','public.{signature}','execute')"),'f')
        with self.assertRaises(AssertionError):call('paws_hq',p_user=99)

    def test_migration_does_not_reset_balance(self):
        self.fund();call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        sql("update paws.pets set breed_id='mixed' where owner_id=42")
        before=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060009_v10.sql').read_text())
        self.assertEqual(before,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))
        self.assertEqual(call('paws_hq',p_user=42)['level'],2);self.assertEqual(call('paws_me',p_user=42)['pet']['breedId'],'mixed')
        self.assertTrue(call('paws_capabilities')['headquarters'])

    def test_z_upgrade_preserves_legacy_income_once(self):
        # Исторический переход v.0.8 → v.0.9 проверяет родитель; затем возвращаем v.1.0.
        super().test_z_upgrade_preserves_legacy_income_once()
        sql((ROOT/'supabase/migrations/202611060009_v10.sql').read_text())

if __name__=='__main__':unittest.main()
