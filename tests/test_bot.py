import unittest
import json
import httpx

from backend.bot import Bot, BotError, validate_app_url


class BotTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_sends_miniapp_button_with_mock_api(self):
        sent=[]
        def handle(request):
            sent.append(json.loads(request.content))
            return httpx.Response(200,json={'ok':True,'result':{'message_id':1}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            bot=Bot('fake-token','https://example.com',client)
            await bot.handle({'message':{'text':'/start','chat':{'id':42,'type':'private'},'from':{'id':42}}})
        self.assertEqual(sent[0]['reply_markup']['inline_keyboard'][0][0]['web_app']['url'],'https://example.com')

    async def test_api_errors_never_expose_token(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(401,json={'ok':False,'error_code':401}))) as client:
            with self.assertRaises(BotError) as error: await Bot('sensitive-token','https://example.com',client).call('getMe')
        self.assertNotIn('sensitive-token',str(error.exception))

    def test_https_required(self):
        for url in ['http://localhost:8000','','https://user:password@example.com']:
            with self.assertRaises(ValueError): validate_app_url(url)
