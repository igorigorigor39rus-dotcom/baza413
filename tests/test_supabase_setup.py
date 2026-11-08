from contextlib import redirect_stdout
from io import StringIO
import unittest
from unittest.mock import patch, MagicMock

from scripts import configure_supabase_bot as setup


class SupabaseSetupTests(unittest.TestCase):
    def pages(self):
        response=MagicMock()
        response.__enter__.return_value.read.return_value=setup.PROJECT_URL.encode()
        return response

    def test_checks_then_configures_webhook_without_printing_secrets(self):
        calls=[];secret='private_webhook_secret_at_least_32_chars';token='sensitive-test-token'
        def request(url,body=None,headers=None):
            calls.append((url,body,headers))
            if url.endswith('/health'): return {'ok':True}
            if url.endswith('/api/config'): return {'appUrl':setup.APP_URL,'features':{'liveTracking':True,'autoLiveStart':True,'starShop':True,'reminders':True,'largestTerritory':True,'dailyIncome':True,'geoChat':True,'breeds':True,'headquarters':True,'sharedPet':True,'unlimitedGpsGap':True,'deletePet':True}}
            if url.endswith('/getMe'): return {'ok':True,'result':{'id':42,'username':'paws_test_bot'}}
            if 'api.telegram.org' in url: return {'ok':True,'result':True}
            return {'ok':True}
        output=StringIO()
        with patch.object(setup,'urlopen',return_value=self.pages()),patch.object(setup,'getpass',side_effect=[token,secret]),patch.object(setup,'request',side_effect=request),redirect_stdout(output):
            setup.main()
        webhook=next(body for url,body,headers in calls if url.endswith('/setWebhook'))
        self.assertEqual(webhook['secret_token'],secret)
        self.assertFalse(webhook['drop_pending_updates'])
        self.assertIn('edited_message',webhook['allowed_updates'])
        self.assertIn('callback_query',webhook['allowed_updates'])
        self.assertIn('pre_checkout_query',webhook['allowed_updates'])
        self.assertEqual(webhook['url'],setup.PROJECT_URL+'/functions/v1/paws-api/webhook')
        self.assertNotIn(token,output.getvalue());self.assertNotIn(secret,output.getvalue())

    def test_mismatched_secret_stops_before_telegram_changes(self):
        calls=[]
        def request(url,body=None,headers=None):
            calls.append(url)
            if url.endswith('/health'): return {'ok':True}
            if url.endswith('/api/config'): return {'appUrl':setup.APP_URL,'features':{'liveTracking':True,'autoLiveStart':True,'starShop':True,'reminders':True,'largestTerritory':True,'dailyIncome':True,'geoChat':True,'breeds':True,'headquarters':True,'sharedPet':True,'unlimitedGpsGap':True,'deletePet':True}}
            if url.endswith('/webhook'): raise RuntimeError('HTTP 401')
            raise AssertionError('Unexpected request')
        with patch.object(setup,'urlopen',return_value=self.pages()),patch.object(setup,'getpass',side_effect=['test-token','private_webhook_secret_at_least_32_chars']),patch.object(setup,'request',side_effect=request),redirect_stdout(StringIO()):
            with self.assertRaisesRegex(RuntimeError,'401'): setup.main()
        self.assertFalse(any('api.telegram.org' in url for url in calls))


if __name__=='__main__': unittest.main()
