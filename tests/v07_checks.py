"""Одноразовая PostGIS: базовая + накопительная миграция v.0.7."""
import unittest
import uuid

import v06_checks
from postgis_checks import ROOT, call, sql


class V07Checks(v06_checks.V06Checks):
    def test_purchase_below_old_minimum_and_above_old_area_radius_and_price(self):
        self.fund()
        small = [{'longitude':x,'latitude':y} for x,y in [(20,54),(20.00001,54),(20.00001,54.00001),(20,54.00001)]]
        quote = call('paws_purchase_quote',p_user=42,p_vertices=small)
        self.assertGreater(quote['area'],0);self.assertLess(quote['area'],1)
        self.assertGreater(call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=small,p_max_cost=quote['cost'])['area'],0)
        large = [{'longitude':x,'latitude':y} for x,y in [(21,55),(21.1,55),(21.1,55.1),(21,55.1)]]
        sql('update paws.wallets set balance=1000000000000,checked_at=clock_timestamp() where owner_id=42')
        quote = call('paws_purchase_quote',p_user=42,p_vertices=large)
        self.assertGreater(quote['area'],10000000);self.assertGreater(quote['cost'],100000000)
        self.assertTrue(quote['affordable'])
        receipt=call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=large,p_max_cost=quote['cost'])
        self.assertEqual(receipt['cost'],quote['cost'])

    def test_zero_area_and_crossing_purchase_still_rejected_without_charge(self):
        self.fund()
        for coords in [[(20,54),(20.001,54),(20.002,54)],[(20,54),(20.001,54.001),(20,54.001),(20.001,54)]]:
            with self.assertRaises(AssertionError):
                call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=[dict(longitude=x,latitude=y) for x,y in coords],p_max_cost=1e12)
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'1000000')
        self.assertEqual(sql('select count(*) from paws.territories'),'0')

    def test_migration_does_not_reset_balance(self):
        self.land();sql('update paws.wallets set balance=123 where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060005_v07.sql').read_text())
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'123')
        self.assertTrue(call('paws_capabilities')['unlimitedPurchases'])

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
        self.assertAlmostEqual(call('paws_wallet',p_user=42)['rate'],receipt['totalArea'],delta=.01)
        self.assertEqual(call('paws_purchase',p_user=42,p_request=request,p_vertices=vertices,p_max_cost=quote['cost']),receipt)

    def test_touching_chain_of_own_territories_merges(self):
        self.land();self.fund()
        # Старые версии хранили смежные собственные участки отдельными строками.
        sql("insert into paws.territories(owner_id,geom,area) select 42,ST_Multi(g),ST_Area(g::geography) from (select ST_MakeEnvelope(20.0002,54,20.0004,54.0002,4326) g) s")
        vertices=self.purchase_vertices(x=20.0004)
        quote=call('paws_purchase_quote',p_user=42,p_vertices=vertices)
        self.assertTrue(quote['merged'])
        call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=quote['cost'])
        self.assertEqual(sql('select count(*) from paws.territories'),'1')
        self.assertEqual(sql('select ST_NumGeometries(geom) from paws.territories'),'1')

    def test_self_overlap_does_not_allow_buying_foreign_land(self):
        self.land();self.fund()
        call('paws_save_pet',p_user=43,p_name='Другой генерал',p_age=2,p_description='',p_color='#397C63')
        sql("insert into paws.territories(owner_id,geom,area) select 43,ST_Multi(g),ST_Area(g::geography) from (select ST_MakeEnvelope(20.0003,54,20.0005,54.0002,4326) g) s")
        vertices=self.purchase_vertices(x=20.0001,width=.0003)
        with self.assertRaises(AssertionError):call('paws_purchase',p_user=42,p_request=str(uuid.uuid4()),p_vertices=vertices,p_max_cost=1e12)
        self.assertEqual(sql('select count(*) from paws.territories'),'2')
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'1000000')


if __name__=='__main__':unittest.main()
