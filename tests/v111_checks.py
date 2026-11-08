"""Локальная PostGIS: удаление анкеты, сохранность чужих данных и старые платежи."""
import unittest,uuid,json
from concurrent.futures import ThreadPoolExecutor
import v11_checks
from postgis_checks import call,sql,ROOT,literal
MIGRATION=ROOT/'supabase/migrations/202611080002_v111.sql'

class V111Checks(v11_checks.V11Checks):
    def setUp(self):
        sql('truncate paws.pet_deletions,paws.photo_cleanup;')
        super().setUp()
    def identity(self,user=42):return sql(f'select profile_id from paws.pets where owner_id={user}')
    def delete(self,user=42,profile=None,name='Рекс',request=None):
        return call('paws_delete_pet',p_actor=user,p_profile=profile or self.identity(user),p_name=name,p_request=request or str(uuid.uuid4()))
    def deletion_order(self,request='order',payer=42):
        return call('paws_star_order',p_user=payer,p_package=sql('select id from paws.star_packages where stars=100'),p_request=request)
    def deletion_checkout(self,order,payer=42):
        call('paws_star_checkout',p_user=payer,p_order=order['id'],p_currency='XTR',p_amount=100,p_query='checkout-'+order['id'])
    def deletion_payment_args(self,order,charge='charge',payer=42):
        return dict(p_user=payer,p_order=order['id'],p_currency='XTR',p_amount=100,p_charge=charge)

    def test_delete_full_profile_frees_land_but_keeps_other_players_and_payment_history(self):
        self.seller();self.fund();self.buy(self.purchase_vertices());self.link()
        call('paws_hq_upgrade',p_user=42,p_request=str(uuid.uuid4()),p_level=1)
        call('paws_activity',p_user=42,p_timezone='Europe/Kaliningrad')
        self.walk(True)
        photo='42/'+str(uuid.uuid4())+'.jpg'
        sql("update paws.pets set photo_key="+literal(photo)+" where owner_id=42;insert into paws.messages(owner_id,text,channel)values(42,'Сообщение','district');")
        order=self.deletion_order();self.deletion_checkout(order);call('paws_star_paid',**self.deletion_payment_args(order))
        foreign_wallet=sql('select row_to_json(w) from paws.wallets w where owner_id=43')
        self.assertTrue(self.delete()['deleted'])
        for table,column in [('pets','owner_id'),('wallets','owner_id'),('territories','owner_id'),('walks','owner_id'),('live_walks','owner_id'),('headquarters','owner_id'),('hq_upgrades','owner_id'),('messages','owner_id'),('activity','owner_id'),('purchases','owner_id'),('account_links','owner_id')]:
            self.assertEqual(sql(f'select count(*) from paws.{table} where {column}=42'),'0',table)
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'88')
        self.assertIsNone(call('paws_me',p_user=42)['pet'])
        self.assertEqual(foreign_wallet,sql('select row_to_json(w) from paws.wallets w where owner_id=43'))
        self.assertEqual(sql('select count(*) from paws.notifications where recipient_id=43'),'1')
        self.assertEqual(sql('select count(*) from paws.star_payments'),'1')
        self.assertEqual(sql('select profile_deleted from paws.star_orders'),'t')
        self.assertEqual(sql('select photo_key from paws.photo_cleanup'),photo)

    def test_delete_then_bind_and_retry_cannot_delete_shared_pet(self):
        self.seller();h='c'*64
        call('paws_account_invite',p_user=43,p_username='joining_general',p_hash=h)
        profile=self.identity();request=str(uuid.uuid4())
        self.delete(profile=profile,request=request)
        joined=call('paws_account_accept',p_user=42,p_username='joining_general',p_hash=h)
        self.assertEqual(joined['primaryId'],'43')
        self.assertTrue(self.delete(profile=profile,request=request)['deleted'])
        with self.assertRaisesRegex(AssertionError,'основной'):self.delete(profile=self.identity(43),name=call('paws_me',p_user=43)['pet']['name'])
        self.assertIsNotNone(call('paws_me',p_user=43)['pet'])

    def test_confirmation_and_generation_guard_prevent_accidental_or_stale_delete_and_save(self):
        old=self.identity()
        with self.assertRaises(AssertionError):self.delete(name='Не та кличка')
        self.assertEqual(sql('select count(*) from paws.pet_deletions'),'0')
        request=str(uuid.uuid4());self.delete(profile=old,request=request)
        call('paws_save_pet',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397c63')
        current=self.identity();self.assertNotEqual(old,current)
        with self.assertRaises(AssertionError):self.delete(profile=old)
        with self.assertRaises(AssertionError):self.delete(profile=current,request=request)
        with self.assertRaises(AssertionError):call('paws_save_profile',p_user=42,p_profile=old,p_name='Старое сохранение',p_age=3,p_description='',p_color='#397c63')
        self.assertEqual(self.identity(),current)
        self.assertEqual(call('paws_me',p_user=42)['pet']['name'],'Рекс')

    def test_concurrent_deletion_retries_are_exactly_once(self):
        profile=self.identity();request=str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=4)as pool:results=list(pool.map(lambda _:self.delete(profile=profile,request=request),range(4)))
        self.assertTrue(all(r['deleted']for r in results))
        self.assertEqual(sql('select count(*) from paws.pet_deletions'),'1')
        self.assertIsNone(call('paws_me',p_user=42)['pet'])

    def test_secondary_and_other_actors_cannot_delete_primary(self):
        self.link();profile=self.identity()
        for actor in [88,99]:
            with self.assertRaises(AssertionError):self.delete(user=actor,profile=profile)
        self.assertIsNotNone(call('paws_me',p_user=42)['pet'])
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'42')

    def test_existing_star_debt_blocks_deletion_without_partial_cleanup(self):
        sql('insert into paws.star_debts(owner_id,amount)values(42,100)')
        with self.assertRaisesRegex(AssertionError,'возвратам Stars'):self.delete()
        self.assertIsNotNone(call('paws_me',p_user=42)['pet'])
        self.assertEqual(sql('select count(*) from paws.pet_deletions'),'0')
        self.assertEqual(sql('select amount from paws.star_debts where owner_id=42'),'100')

    def test_late_payments_and_refunds_cannot_credit_or_debit_a_new_profile(self):
        paid=self.deletion_order('paid');self.deletion_checkout(paid);paid_args=self.deletion_payment_args(paid,'paid-charge')
        call('paws_star_paid',**paid_args)
        late=self.deletion_order('late');self.deletion_checkout(late)
        unpaid=self.deletion_order('unpaid')
        self.delete()
        call('paws_save_pet',p_user=42,p_name='Новый',p_age=1,p_description='',p_color='#397c63')
        sql('insert into paws.wallets(owner_id,balance)values(42,5000)')
        with self.assertRaises(AssertionError):self.deletion_checkout(unpaid)
        with self.assertRaisesRegex(AssertionError,'возвращена'):call('paws_star_paid',**self.deletion_payment_args(late,'late-charge'))
        self.assertFalse(call('paws_star_paid',**paid_args)['credited'])
        self.assertTrue(call('paws_star_refunded',**paid_args)['changed'])
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],5000)
        self.assertEqual(sql('select count(*) from paws.star_debts'),'0')

    def test_photo_cleanup_leases_retry_and_service_only_permissions(self):
        photo='42/'+str(uuid.uuid4())+'.jpg';sql('update paws.pets set photo_key='+literal(photo)+' where owner_id=42')
        self.delete()
        with ThreadPoolExecutor(max_workers=3)as pool:claims=list(pool.map(lambda _:call('paws_photo_cleanup_claim'),range(3)))
        claimed=[p for r in claims for p in r['photos']];self.assertEqual(len(claimed),1);item=claimed[0]
        call('paws_photo_cleanup_finish',p_key=photo,p_token=str(uuid.uuid4()),p_ok=True)
        self.assertEqual(sql('select count(*) from paws.photo_cleanup'),'1')
        call('paws_photo_cleanup_finish',p_key=photo,p_token=item['token'],p_ok=False)
        self.assertEqual(call('paws_photo_cleanup_claim')['photos'],[])
        sql("update paws.photo_cleanup set retry_at=clock_timestamp()-interval '1 second'")
        retry=call('paws_photo_cleanup_claim')['photos'][0]
        call('paws_photo_cleanup_finish',p_key=photo,p_token=retry['token'],p_ok=True)
        self.assertEqual(sql('select count(*) from paws.photo_cleanup'),'0')
        for sig in ['paws_delete_pet(bigint,uuid,text,uuid)','paws_save_profile(bigint,uuid,text,numeric,text,text,integer,integer,numeric,text,text,text)','paws_photo_cleanup_claim(integer)']:
            self.assertEqual(sql(f"select has_function_privilege('anon','public.{sig}','execute')"),'f')

    def test_migration_does_not_reset_balance(self):
        self.fund();self.link();before=self.identity();wallet=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        sql(MIGRATION.read_text())
        self.assertEqual(self.identity(),before)
        self.assertEqual(wallet,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))
        self.assertEqual(call('paws_account_resolve',p_user=88)['ownerId'],'42')
        self.assertTrue(call('paws_capabilities')['deletePet'])

    def test_z_upgrade_preserves_legacy_income_once(self):
        super().test_z_upgrade_preserves_legacy_income_once();sql(MIGRATION.read_text())

if __name__=='__main__':unittest.main()
