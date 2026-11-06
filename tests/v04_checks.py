"""Только одноразовая PostGIS: базовая миграция + ЕДИНАЯ 202611060002_v04."""
import json
import unittest
import dossier_checks
from postgis_checks import sql, call, ROOT


class V04Checks(dossier_checks.DossierChecks):
    def test_public_wallet_read_does_not_change_other_ledger(self):
        area=self.land()['area']
        sql("update paws.wallets set balance=123,checked_at=clock_timestamp()-interval '1 hour' where owner_id=42")
        snapshot=sql('select row_to_json(w) from paws.wallets w where owner_id=42')
        other=call('paws_pet',p_user=99,p_pet=42)
        self.assertAlmostEqual(float(other['wallet']['balance']),123+area,delta=.2)
        self.assertEqual(snapshot,sql('select row_to_json(w) from paws.wallets w where owner_id=42'))

    def test_capabilities_and_upload_limit(self):
        features=call('paws_capabilities')
        self.assertTrue(features['chat']);self.assertTrue(features['publicWallet'])
        self.assertEqual(sql("select file_size_limit from storage.buckets where id='paws-photos'"),'1000000')
        self.assertEqual(sql("select has_function_privilege('anon','public.paws_capabilities()','execute')"),'f')

    def test_migration_does_not_reset_balance(self):
        self.land();sql('update paws.wallets set balance=123 where owner_id=42')
        sql((ROOT/'supabase/migrations/202611060002_v04.sql').read_text())
        self.assertEqual(sql('select balance from paws.wallets where owner_id=42'),'123')
        self.assertTrue(call('paws_capabilities')['publicWallet'])


if __name__=='__main__':unittest.main()
