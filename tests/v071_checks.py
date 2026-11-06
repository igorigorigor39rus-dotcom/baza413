"""Только одноразовая PostGIS: базовая + накопительная миграция v.0.7.1."""
from concurrent.futures import ThreadPoolExecutor
import json
import unittest
import uuid

import v07_checks
from postgis_checks import ROOT, call, literal, sql


class V071Checks(v07_checks.V07Checks):
    def setUp(self):
        sql('truncate paws.notifications,paws.purchases,paws.live_walks,paws.wallets,paws.messages,paws.walks,paws.territories,paws.pets;')
        call('paws_save_pet',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397C63')

    def seller(self,user=43,x=20,width=.0002):
        call('paws_save_pet',p_user=user,p_name=f'Барсик {user}',p_age=2,p_description='',p_color='#397C63')
        sql(f"insert into paws.territories(owner_id,geom,area) select {user},ST_Multi(g),ST_Area(g::geography) from(select ST_MakeEnvelope({x},54,{x+width},54.0002,4326) g) s")
        sql(f'update paws.wallets set balance=123,checked_at=clock_timestamp() where owner_id={user}')

    def buy(self,vertices=None,request=None):
        return call('paws_purchase',p_user=42,p_request=request or str(uuid.uuid4()),p_vertices=vertices or self.purchase_vertices(),p_max_cost=1e12)

    def test_full_foreign_buyout_ten_percent_and_exactly_once_credit(self):
        self.seller();self.fund();vertices=self.purchase_vertices();request=str(uuid.uuid4())
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertEqual(quote['ownersCount'],1);self.assertEqual(sql('select count(*) from paws.notifications'),'0')
        result=self.buy(vertices,request);amount=result['reparations'][0]['amount']
        self.assertEqual(amount,result['cost']/10)
        self.assertAlmostEqual(float(sql('select balance from paws.wallets where owner_id=43')),123+amount,delta=.2)
        self.assertEqual(call('paws_me',p_user=43)['area'],0)
        self.assertEqual(self.buy(vertices,request),result)
        self.assertEqual(sql('select count(*) from paws.notifications'),'1')
        text=call('paws_notifications',p_user=43)['notifications'][0]['message']
        self.assertTrue(text.startswith('Рекс выкупил вашу территорию, вам выплачены репарации в количестве '))
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],result['area'],delta=.01)

    def test_partial_foreign_and_neutral_only_foreign_part_pays(self):
        self.seller();self.fund();original=call('paws_me',p_user=43)['area']
        result=self.buy(self.purchase_vertices(x=20.0001))
        self.assertAlmostEqual(result['reparations'][0]['amount'],result['cost']/20,delta=.001)
        self.assertAlmostEqual(call('paws_me',p_user=43)['area'],original/2,delta=.01)
        self.assertEqual(sql('select count(*) from paws.territories'),'2')
        self.assertEqual(sql('select coalesce(sum(ST_Area(ST_Intersection(a.geom,b.geom)::geography)),0) from paws.territories a join paws.territories b on a.id<b.id'),'0')

    def test_multiple_sellers_each_gets_only_own_share(self):
        self.seller(43,width=.0001);self.seller(44,x=20.0001,width=.0001);self.fund()
        result=self.buy();self.assertEqual(len(result['reparations']),2)
        self.assertAlmostEqual(sum(r['amount'] for r in result['reparations']),result['cost']/10,delta=.000001)
        self.assertEqual({r['ownerId'] for r in result['reparations']},{'43','44'})
        self.assertEqual(sql('select count(*) from paws.notifications'),'2')

    def test_self_overlap_does_not_allow_buying_foreign_land(self):
        # В v.0.7.1 смешанный контур разрешён: свой кусок не оплачивается,
        # нейтральный покупается, чужой выкупается с репарациями.
        self.land();self.seller(43,x=20.0003);self.fund()
        result=self.buy(self.purchase_vertices(x=20.0001,width=.0003))
        self.assertTrue(result['merged']);self.assertEqual(len(result['reparations']),1)
        self.assertGreater(result['reparations'][0]['amount'],0)
        self.assertLess(result['reparations'][0]['amount'],result['cost']/10)

    def test_failed_payment_changes_neither_seller_nor_territory_nor_notifications(self):
        self.seller();before=sql('select row_to_json(w) from paws.wallets w where owner_id=43')
        with self.assertRaises(AssertionError):self.buy()
        self.assertEqual(sql('select row_to_json(w) from paws.wallets w where owner_id=43'),before)
        self.assertEqual(sql('select count(*) from paws.territories where owner_id=43'),'1')
        self.assertEqual(sql('select count(*) from paws.notifications'),'0')
        self.assertEqual(sql('select count(*) from paws.purchases'),'0')

    def test_gps_capture_foreground_and_live_never_pay_reparations(self):
        for live in (False,True):
            self.setUp();self.seller()
            points=self.points([(0,0),(.0002,0),(.0002,.0002),(0,.0002),(0,0)])
            result=self.capture(points,live=live)
            self.assertGreater(result['area'],0)
            self.assertEqual(sql('select count(*) from paws.notifications'),'0')
            self.assertEqual(sql('select count(*) from paws.purchases'),'0')
            self.assertAlmostEqual(float(sql('select balance from paws.wallets where owner_id=43')),123,delta=.2)

    def test_two_buyers_cannot_purchase_same_free_land(self):
        # Два последовательных выкупа теперь допустимы. Блокировка по-прежнему
        # сохраняет один текущий участок и одну выплату за второй выкуп.
        call('paws_save_pet',p_user=43,p_name='Барсик',p_age=2,p_description='',p_color='#397C63')
        self.fund(42);self.fund(43);vertices=self.purchase_vertices()
        def buy(user):return call('paws_purchase',p_user=user,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1e12)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(buy,[42,43]))
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertEqual(sql('select count(*) from paws.purchases'),'2')
        self.assertEqual(sql('select count(*) from paws.notifications'),'1')
        self.assertEqual(sum(len(r['reparations']) for r in results),1)

    def test_outbox_lease_retry_and_private_history(self):
        self.seller();self.fund();self.buy()
        with ThreadPoolExecutor(2) as pool:claims=list(pool.map(lambda _:call('paws_notify_claim'),range(2)))
        messages=[m for c in claims for m in c['messages']];self.assertEqual(len(messages),1)
        note=messages[0]
        call('paws_notify_finish',p_id=note['id'],p_token=note['leaseToken'],p_ok=False)
        self.assertEqual(call('paws_notify_claim')['messages'],[])
        sql("update paws.notifications set retry_at=clock_timestamp()-interval '1 second'")
        second=call('paws_notify_claim')['messages'][0]
        self.assertNotEqual(second['leaseToken'],note['leaseToken'])
        call('paws_notify_finish',p_id=note['id'],p_token=note['leaseToken'],p_ok=True)
        self.assertEqual(sql('select telegram_sent_at is null from paws.notifications'),'t')
        call('paws_notify_finish',p_id=second['id'],p_token=second['leaseToken'],p_ok=True)
        self.assertEqual(call('paws_notify_claim')['messages'],[])
        call('paws_notifications_read',p_user=42,p_ids=[note['id']])
        self.assertEqual(call('paws_notifications',p_user=43)['unread'],1)
        call('paws_notifications_read',p_user=43,p_ids=[note['id']])
        self.assertEqual(call('paws_notifications',p_user=43)['unread'],0)
        self.assertEqual(call('paws_notifications',p_user=42)['notifications'],[])
        self.assertEqual(sql("select has_table_privilege('anon','paws.notifications','select')"),'f')

    def test_migration_does_not_reset_balance(self):
        self.seller();self.fund();self.buy()
        before=sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w')
        sql((ROOT/'supabase/migrations/202611060006_v071.sql').read_text())
        self.assertEqual(sql('select json_agg(row_to_json(w) order by owner_id) from paws.wallets w'),before)
        self.assertEqual(sql('select count(*) from paws.notifications'),'1')
        self.assertTrue(call('paws_capabilities')['foreignBuyouts'])


if __name__=='__main__':unittest.main()
