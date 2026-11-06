"""Только одноразовый PostGIS после ОБЕИХ миграций. Не запускать на рабочей БД."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from postgis_checks import sql, call, route, literal, ROOT


class DossierChecks(unittest.TestCase):
    def setUp(self):
        sql('truncate paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Агент',p_age=3,p_description='Досье',p_color='#397C63')

    def land(self):
        w=call('paws_start',p_user=42)['id']
        sql(f"update paws.walks set started_at=clock_timestamp()-interval '120 seconds' where id={literal(w)}")
        return call('paws_capture',p_user=42,p_walk=w,p_points=route(width=.0002,height=.0002))

    def test_income_offline_and_loss(self):
        area=self.land()['area']
        sql("update paws.wallets set balance=0,checked_at=clock_timestamp()-interval '1 hour' where owner_id=42;")
        sql('delete from paws.territories where owner_id=42;')
        wallet=call('paws_wallet',p_user=42)
        self.assertAlmostEqual(float(wallet['balance']),area,delta=.2)
        self.assertEqual(wallet['rate'],0)
        again=call('paws_wallet',p_user=42)
        self.assertEqual(wallet['balance'],again['balance'])

    def test_concurrent_wallet_not_double_payment(self):
        area=self.land()['area']
        sql("update paws.wallets set balance=0,checked_at=clock_timestamp()-interval '1 hour' where owner_id=42;")
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _:call('paws_wallet',p_user=42),range(2)))
        for result in results:self.assertAlmostEqual(float(result['balance']),area,delta=.2)

    def test_dossier_and_invalid_style(self):
        data=dict(p_user=42,p_name='Агент',p_age=3,p_description='Досье',p_color='#123456',p_hue=210,p_saturation=70,p_opacity=.5,p_pattern='grid')
        pet=call('paws_save_dossier',**data)['pet']
        self.assertEqual(pet['hue'],210);self.assertEqual(pet['pattern'],'grid')
        with self.assertRaises(AssertionError):call('paws_save_dossier',**{**data,'p_hue':400})
        self.assertEqual(call('paws_me',p_user=42)['pet']['hue'],210)

    def test_chat_identity_rate_limit_and_permissions(self):
        call('paws_send',p_user=42,p_text='<script>test</script>')
        messages=call('paws_chat',p_user=42,p_after=0)['messages']
        self.assertEqual(messages[0]['pet']['id'],'42')
        self.assertEqual(messages[0]['text'],'<script>test</script>')
        with self.assertRaises(AssertionError):call('paws_send',p_user=42,p_text='Слишком быстро')
        with self.assertRaises(AssertionError):call('paws_send',p_user=99,p_text='Нет профиля')
        self.assertEqual(call('paws_chat',p_user=42,p_after=messages[0]['id'])['messages'],[])
        for name in ['paws_wallet(bigint)','paws_send(bigint,text)','paws_chat(bigint,bigint)']:
            self.assertEqual(sql(f"select has_function_privilege('anon','public.{name}','execute')"),'f')

    def test_migration_does_not_reset_balance(self):
        self.land();sql('update paws.wallets set balance=123 where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060001_dossier.sql').read_text())
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'123')


if __name__=='__main__': unittest.main()
