import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('configure', Path(__file__).resolve().parents[1] / 'scripts/configure_feedback_bot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SetupTests(unittest.TestCase):
    def valid(self):
        return {'FEEDBACK_BOT_TOKEN': '12345:NOT_A_REAL_TOKEN', 'FEEDBACK_WEBHOOK_SECRET': 's' * 48,
                'FEEDBACK_ADMIN_IDS': '1,2', 'FEEDBACK_ADMIN_CHAT_ID': '-100123'}

    def test_valid_config_and_bootstrap(self):
        module.validate(self.valid())
        module.validate({**self.valid(), 'FEEDBACK_ADMIN_IDS': '', 'FEEDBACK_ADMIN_CHAT_ID': ''})

    def test_reject_invalid_secret_group_and_admin(self):
        for key, value in [('FEEDBACK_WEBHOOK_SECRET', 'short'), ('FEEDBACK_ADMIN_IDS', '1, 2'),
                           ('FEEDBACK_ADMIN_CHAT_ID', '123'), ('FEEDBACK_BOT_TOKEN', 'wrong')]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                module.validate({**self.valid(), key: value})

    def test_env_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.feedback'
            path.write_text('\ufeff# comment\nFEEDBACK_ADMIN_IDS=1,2\nFEEDBACK_ADMIN_CHAT_ID=-100\n', encoding='utf-8')
            self.assertEqual(module.read_env(path)['FEEDBACK_ADMIN_IDS'], '1,2')

    def test_init_does_not_overwrite_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.feedback'
            path.write_text('old-secret')
            with patch.object(module, 'ENV', path), self.assertRaises(RuntimeError):
                module.initialize()
            self.assertEqual(path.read_text(), 'old-secret')

    def test_refuse_to_replace_game_webhook(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env.feedback'
            path.write_text('\n'.join(f'{key}={value}' for key, value in self.valid().items()))
            with patch.object(module, 'ENV', path), patch.object(module, 'request_json', return_value={'service': 'dogwars-feedback', 'configured': True}), \
                 patch.object(module, 'telegram', return_value={'url': 'https://project.supabase.co/functions/v1/paws-api'}) as api:
                with self.assertRaisesRegex(RuntimeError, 'другой webhook'):
                    module.register(module.PROJECT)
                self.assertEqual(api.call_args.args[1], 'getWebhookInfo')

    def test_404_errors_do_not_include_bot_token(self):
        from urllib.error import HTTPError
        error = HTTPError('https://example/secret-token', 404, 'secret-token', {}, None)
        with patch.object(module.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                module.request_json('https://example/secret-token')
            self.assertIn('HTTP 404', str(caught.exception))
            self.assertNotIn('secret-token', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
