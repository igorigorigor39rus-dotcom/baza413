"""Одноразовая PostGIS: базовая миграция + накопительная v.0.9."""
import json,time,unittest,uuid
from concurrent.futures import ThreadPoolExecutor
import v08_checks
from postgis_checks import ROOT,call,sql,literal

class V09Checks(v08_checks.V08Checks):
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
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],result['area']/10,delta=.01)

    def test_overlap_with_own_land_pays_only_added_area_and_merges(self):
        original=self.land()['area'];self.fund()
        vertices=self.purchase_vertices(x=20.0001)
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertTrue(quote['merged'])
        self.assertAlmostEqual(quote['area'],original/2,delta=.01)
        self.assertAlmostEqual(quote['selectedArea'],original,delta=.01)
        request=str(uuid.uuid4())
        receipt=call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost'])
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertAlmostEqual(receipt['totalArea'],original+quote['area'],delta=.01)
        self.assertAlmostEqual(float(sql('select balance from paws.wallets where owner_id=42')),1000000-quote['cost'],delta=.2)
        self.assertAlmostEqual(call('paws_me',p_user=42)['area'],receipt['totalArea'],delta=.01)
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],receipt['totalArea']/10,delta=.01)
        self.assertEqual(call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost']),receipt)

    def test_purchase_cost_atomic_balance_and_idempotent_receipt(self):
        vertices=self.purchase_vertices();self.fund()
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertEqual(quote['cost'],__import__('math').ceil(quote['area']*10))
        request=str(uuid.uuid4())
        result=call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost'])
        self.assertEqual(float(sql('select balance from paws.wallets where owner_id=42')),1000000-quote['cost'])
        self.assertEqual(call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost']),result)
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertEqual(sql("select has_table_privilege('anon','paws.purchases','select')"),'f')
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],quote['area']/10,delta=.01)

    def daily_seed(self,area=100,hours=0,pending=0,balance=0):
        if sql('select count(*) from paws.territories where owner_id=42')=='0':self.seller(42)
        sql(f"update paws.territories set area={area} where owner_id=42")
        sql(f"with tick as materialized(select clock_timestamp() as moment) update paws.wallets set balance={balance},income_pending={pending},income_cycle_at=tick.moment-interval '{hours} hours',checked_at=tick.moment-interval '{hours} hours' from tick where owner_id=42")

    def project(self,seconds,user=42):
        return json.loads(sql(f"select paws.daily_wallet({user},income_cycle_at+interval '{seconds} seconds') from paws.wallets where owner_id={user}"))

    def test_income_offline_and_loss(self):
        self.daily_seed(hours=12)
        sql('delete from paws.territories where owner_id=42')
        wallet=call('paws_wallet',p_user=42)
        self.assertEqual(wallet['balance'],0);self.assertAlmostEqual(wallet['pending'],5,delta=.001)
        # После потери земли незавершённый доход выплачивается в свой срок.
        sql("update paws.wallets set income_cycle_at=income_cycle_at-interval '13 hours',checked_at=checked_at-interval '13 hours' where owner_id=42")
        wallet=call('paws_wallet',p_user=42)
        self.assertAlmostEqual(wallet['balance'],5,delta=.001);self.assertEqual(wallet['rate'],0)
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],wallet['balance'])

    def test_concurrent_wallet_not_double_payment(self):
        self.daily_seed(hours=24)
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:call('paws_wallet',p_user=42),range(4)))
        for result in results:self.assertAlmostEqual(result['balance'],10,places=8)
        self.assertAlmostEqual(float(sql('select balance from paws.wallets where owner_id=42')),10,places=8)

    def test_public_wallet_read_does_not_change_other_ledger(self):
        self.daily_seed(hours=12,balance=123)
        before=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        other=call('paws_pet',p_user=99,p_pet=42)['wallet']
        self.assertEqual(other['balance'],123);self.assertEqual(other['rate'],10)
        self.assertNotIn('debt',other);self.assertNotIn('pending',other)
        self.assertEqual(before,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))

    def test_gps_capture_foreground_and_live_never_pay_reparations(self):
        for live in(False,True):
            self.setUp();self.seller()
            before=call('paws_wallet',p_user=43)['balance']
            self.capture(self.points([(0,0),(.0002,0),(.0002,.0002),(0,.0002),(0,0)]),live=live)
            self.assertEqual(call('paws_wallet',p_user=43)['balance'],before)
            self.assertEqual(sql('select count(*) from paws.notifications'),'0')
            self.assertEqual(sql('select count(*) from paws.purchases'),'0')

    def test_daily_exact_boundary_offline_and_fractional_land(self):
        self.daily_seed(area=5)
        self.assertEqual(self.project(86399)['balance'],0)
        self.assertEqual(self.project(86400)['balance'],.5)
        self.assertEqual(self.project(86400*3.5)['balance'],1.5)
        self.assertEqual(self.project(86400*3.5)['pending'],.25)
        self.assertEqual(self.project(86400*3.5)['rate'],.5)

    def test_daily_area_change_before_payday_no_free_full_day(self):
        self.daily_seed(area=100,hours=8)
        sql('update paws.territories set area=50 where owner_id=42')
        self.assertEqual(call('paws_wallet',p_user=42)['balance'],0)
        future=self.project(86400)
        self.assertAlmostEqual(future['balance'],20/3,delta=.001)
        self.assertEqual(future['rate'],5)

    def test_daily_pending_cannot_be_spent_or_pay_refund_debt_early(self):
        self.daily_seed(area=100,hours=12)
        sql('insert into paws.star_debts(owner_id,amount) values(42,3)')
        wallet=call('paws_wallet',p_user=42)
        self.assertEqual(wallet['balance'],0);self.assertEqual(wallet['debt'],3)
        self.assertGreater(wallet['pending'],4.9)
        vertices=[dict(longitude=x,latitude=y) for x,y in [(20.01,54),(20.010005,54),(20.010005,54.000005),(20.01,54.000005)]]
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertLess(quote['cost'],wallet['pending']);self.assertFalse(quote['affordable'])
        with self.assertRaises(AssertionError):call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=quote['cost'])
        future=self.project(86400);self.assertAlmostEqual(future['balance'],7,delta=.001);self.assertEqual(future['debt'],0)

    def test_initial_period_starts_with_first_land(self):
        call('paws_wallet',p_user=42)
        self.assertEqual(sql('select income_cycle_at is null from paws.wallets where owner_id=42'),'t')
        sql("update paws.wallets set checked_at=clock_timestamp()-interval '10 days' where owner_id=42")
        self.seller(42)
        wallet=call('paws_wallet',p_user=42)
        self.assertEqual(wallet['balance'],123)
        self.assertGreater(wallet['nextPayoutAt'],time.time()+86390)

    def test_migration_does_not_reset_balance(self):
        self.daily_seed(hours=12,balance=123,pending=2)
        before=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060008_v09.sql').read_text())
        self.assertEqual(before,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))
        caps=call('paws_capabilities');self.assertTrue(caps['dailyIncome']);self.assertTrue(caps['geoChat'])

    def neighbor(self,user,km,area=100):
        from pyproj import Geod
        x,y,_=Geod(ellps='WGS84').fwd(20,54,90,km*1000)
        call('paws_save_pet',p_user=user,p_name=str(user),p_age=2,p_description='',p_color='#397C63')
        sql(f"insert into paws.territories(owner_id,geom,area) select {user},ST_Multi(ST_MakeEnvelope({x}-.00001,{y}-.00001,{x}+.00001,{y}+.00001,4326)),{area}")

    def test_chat_identity_rate_limit_and_permissions(self):
        self.neighbor(42,0)
        call('paws_send_room',p_user=42,p_channel='district',p_text='<script>test</script>')
        room=call('paws_chat_room',p_user=42,p_channel='district')
        self.assertEqual(room['messages'][0]['pet']['id'],'42');self.assertTrue(room['canPost'])
        with self.assertRaises(AssertionError):call('paws_send_room',p_user=42,p_channel='city',p_text='switch bypass')
        with self.assertRaises(AssertionError):call('paws_send',p_user=42,p_text='old client bypass')
        for sig in ['paws_chat_room(bigint,text,bigint)','paws_send_room(bigint,text,text)']:
            self.assertEqual(sql(f"select has_function_privilege('anon','public.{sig}','execute')"),'f')

    def test_chat_radius_boundaries_rooms_and_largest_anchor(self):
        self.neighbor(42,0)
        for user,km in [(43,1.99),(44,2.01),(45,19.99),(46,20.01)]:
            self.neighbor(user,km)
            sql(f"insert into paws.messages(owner_id,channel,text) values({user},'district','d{user}'),({user},'city','c{user}'),({user},'world','w{user}')")
        district=call('paws_chat_room',p_user=42,p_channel='district')
        city=call('paws_chat_room',p_user=42,p_channel='city')
        self.assertEqual([m['pet']['id'] for m in district['messages']],['43'])
        self.assertEqual([m['pet']['id'] for m in city['messages']],['43','44','45'])
        world=call('paws_chat_room',p_user=42,p_channel='world');self.assertEqual(len(world['messages']),4)
        self.assertEqual(call('paws_chat_room',p_user=42,p_channel='district',p_after=district['messages'][0]['id'])['messages'],[])
        # Маленький ближний участок не должен заменять крупнейший дальний.
        self.neighbor(42,100,area=101)
        self.assertEqual(call('paws_chat_room',p_user=42,p_channel='district')['messages'],[])

    def test_chat_no_land_read_world_and_world_million_threshold(self):
        for channel in ('district','city'):
            room=call('paws_chat_room',p_user=42,p_channel=channel)
            self.assertFalse(room['canRead']);self.assertFalse(room['canPost'])
        self.assertTrue(call('paws_chat_room',p_user=99,p_channel='world')['canRead'])
        self.assertFalse(call('paws_chat_room',p_user=42,p_channel='world')['canPost'])
        self.neighbor(42,0,area=999999)
        with self.assertRaises(AssertionError):call('paws_send_room',p_user=42,p_channel='world',p_text='early')
        self.neighbor(42,1,area=1)
        self.assertTrue(call('paws_chat_room',p_user=42,p_channel='world')['canPost'])
        call('paws_send',p_user=42,p_text='exact million')
        self.assertEqual(call('paws_chat',p_user=99)['messages'][0]['text'],'exact million')
        sql('update paws.territories set area=0.1 where owner_id=42')
        self.assertFalse(call('paws_chat_room',p_user=42,p_channel='world')['canPost'])
        with self.assertRaises(AssertionError):call('paws_chat_room',p_user=42,p_channel='bad')

    def assert_live_help(self):
        with self.assertRaises(AssertionError) as error:call('paws_live_capture',p_user=42)
        self.assertIn('Включите трансляцию: 📎',str(error.exception))
        self.assertIn('Транслировать геопозицию',str(error.exception))

    def test_capture_help_without_broadcast_and_prepared_walk(self):
        self.assert_live_help();self.walk(True);self.assert_live_help()
        self.assertEqual(sql('select count(*) from paws.territories'),'0')

    def test_capture_help_after_stop_and_fresh_transmission_restarts_safely(self):
        now=time.time();point=dict(latitude=54,longitude=20,accuracy=20,timestamp=now)
        self.assertTrue(self.receive(point)['accepted'])
        before=sql('select points from paws.live_walks where owner_id=42')
        call('paws_live_receive',p_user=42,p_message=77,p_update=2,p_timestamp=now+1,p_sent_at=now,p_longitude=20,p_latitude=54,p_accuracy=20,p_period=0,p_initial='false')
        self.assert_live_help()
        self.assertEqual(sql('select points from paws.live_walks where owner_id=42'),before)
        # Старая доставка не должна включать остановленную трансляцию.
        self.receive(point,update=1,initial=False)
        self.assertEqual(sql('select broadcast_stopped from paws.live_walks where owner_id=42'),'t')
        fresh={**point,'timestamp':time.time()}
        self.assertTrue(self.receive(fresh,update=3,message=78)['accepted'])
        self.assertEqual(sql('select count(*) from paws.walks where active'),'1')
        self.assertEqual(sql('select jsonb_array_length(points) from paws.live_walks where message_id=77'),'0')

    def test_capture_help_when_broadcast_expired(self):
        now=time.time();point=dict(latitude=54,longitude=20,accuracy=20,timestamp=now)
        self.assertTrue(self.receive(point)['accepted'])
        sql("update paws.live_walks set broadcast_until=clock_timestamp()-interval '1 second'")
        self.assert_live_help()

    def test_new_telegram_stream_replaces_legacy_foreground_session(self):
        self.walk(False)
        point=dict(latitude=54,longitude=20,accuracy=20,timestamp=time.time())
        self.assertTrue(self.receive(point)['accepted'])
        self.assertEqual(sql('select count(*) from paws.walks where active'),'1')
        self.assertEqual(sql('select count(*) from paws.live_walks'),'1')

    def test_extra_camouflage_patterns_persist_and_old_values_remain(self):
        for pattern in ('solid','stripes','grid','camo','digital','tiger','flecktarn'):
            response=call('paws_save_dossier',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397c63',p_hue=150,p_saturation=55,p_opacity=.35,p_pattern=pattern)
            self.assertEqual(response['pet']['pattern'],pattern)
        with self.assertRaises(AssertionError):call('paws_save_dossier',p_user=42,p_name='Рекс',p_age=3,p_description='',p_color='#397c63',p_hue=150,p_saturation=55,p_opacity=.35,p_pattern='bad')

    def test_z_upgrade_preserves_legacy_income_once(self):
        self.daily_seed(area=100)
        sql((ROOT/'supabase/migrations/202611060007_v08.sql').read_text())
        sql("delete from paws.economy_versions where version=9;update paws.wallets set balance=7,checked_at=clock_timestamp()-interval '1 hour',income_cycle_at=null,income_pending=0 where owner_id=42")
        sql((ROOT/'supabase/migrations/202611060008_v09.sql').read_text())
        wallet=call('paws_wallet',p_user=42);self.assertAlmostEqual(wallet['balance'],107,delta=.05);self.assertEqual(wallet['rate'],10)
        before=sql('select balance from paws.wallets where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060008_v09.sql').read_text())
        self.assertEqual(before,sql('select balance from paws.wallets where owner_id=42'))

if __name__=='__main__':unittest.main()
