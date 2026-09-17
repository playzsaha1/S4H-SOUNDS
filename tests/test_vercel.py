"""Vercel adapter and shared-state semantics (pip install 'fakeredis[lua]')."""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.redis_counter import RedisCounter
from backend.vercel_handler import handler
from server import Rejected, Server

try:
    import fakeredis
except ImportError:
    fakeredis = None


@unittest.skipUnless(fakeredis, "Install fakeredis[lua] to test shared Redis scripts")
class RedisTests(unittest.TestCase):
    def setUp(self):
        self.redis = fakeredis.FakeRedis()
        self.counter = RedisCounter('https://test.upstash.io', 'test-token', limit=5)
        self.counter.command = self.redis.execute_command

    def test_zero_initialization_and_no_visit_increments(self):
        for _ in range(3):
            self.assertEqual(self.counter.stats(), {'total': 0, 'downloads': 0})
        self.counter.ticket()
        self.assertEqual(self.counter.stats(), {'total': 0, 'downloads': 0})

    def test_parallel_completion_and_download_are_atomic(self):
        token = self.counter.ticket()
        with self.assertRaises(Rejected):
            self.counter.download(token)
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            values = list(pool.map(self.counter.complete, [token] * 20))
        self.assertEqual(values, [1] * 20)
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            values = list(pool.map(self.counter.download, [token] * 20))
        self.assertTrue(all(value == {'total': 1, 'downloads': 1} for value in values))
        self.assertEqual(self.counter.complete(token), 1)

    def test_independent_function_instances_share_state(self):
        token = self.counter.ticket()
        other = RedisCounter('https://test.upstash.io', 'test-token')
        other.command = self.redis.execute_command
        other.complete(token)
        self.assertEqual(self.counter.total(), 1)
        self.counter.download(token)
        self.assertEqual(other.stats(), {'total': 1, 'downloads': 1})

    def test_rate_limit_and_ephemeral_keys(self):
        tokens = [self.counter.ticket() for _ in range(5)]
        with self.assertRaises(Rejected) as caught:
            self.counter.ticket()
        self.assertEqual(caught.exception.status, 429)
        self.counter.complete(tokens[0])
        self.counter.download(tokens[0])
        self.assertGreater(self.redis.ttl(self.counter.PREFIX + 'ticket:' + tokens[0]), 0)
        for key in self.redis.keys():
            if key.decode().endswith(':totals'):
                self.assertEqual(self.redis.ttl(key), -1)
            else:
                self.assertGreater(self.redis.ttl(key), 0)
        self.redis.delete(self.counter.PREFIX + 'ticket:' + tokens[0])
        with self.assertRaises(Rejected):
            self.counter.complete(tokens[0])
        with self.assertRaises(Rejected):
            self.counter.download(tokens[0])
        self.assertEqual(self.counter.stats(), {'total': 1, 'downloads': 1})


class VercelHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def request(self, path, body=None, origin='https://s4h-sounds.vercel.app'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        headers = {'Origin': origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-S4H-Request': 'conversion'}
        connection.request('GET' if body is None else 'POST', path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read()), response.getheader('Cache-Control')
        connection.close()
        return result

    def test_missing_configuration_returns_explicit_503_not_fake_zero(self):
        with patch.dict(os.environ, {}, clear=True):
            code, body, cache = self.request('/api/stats')
            self.assertEqual(code, 503)
            self.assertIn('not connected', body['error'])
            self.assertNotIn('total', body)
            self.assertEqual(cache, 'no-store')
            self.assertEqual(self.request('/api/ticket', {})[0], 503)
            self.assertEqual(self.request('/api/ticket', {}, origin='https://evil.example')[0], 403)

    def test_function_does_not_serve_source_or_assets(self):
        self.assertEqual(self.request('/server.py')[0], 405)
        self.assertEqual(self.request('/api/ticket')[0], 405)

    def test_read_uses_shared_store_and_no_cache(self):
        with patch('backend.vercel_handler.RedisCounter') as factory:
            factory.return_value.stats.return_value = {'total': 12, 'downloads': 7}
            code, body, cache = self.request('/api/stats')
            self.assertEqual((code, body, cache), (200, {'total': 12, 'downloads': 7}, 'no-store'))


class ConfigurationTests(unittest.TestCase):
    def test_routes_keep_api_separate_from_html(self):
        config = json.loads((Path(__file__).resolve().parents[1] / 'vercel.json').read_text())
        self.assertEqual(
            {(build['src'], build['use']) for build in config['builds']},
            {('index.html', '@vercel/static'), ('*.css', '@vercel/static'),
             ('*.js', '@vercel/static'), ('api/*.py', '@vercel/python')},
        )
        self.assertEqual({rule['source'] for rule in config['rewrites']}, {'/app', '/app/downloads', '/privacy'})
        for endpoint in ['stats', 'count', 'ticket', 'complete', 'download']:
            self.assertTrue((Path(__file__).resolve().parents[1] / 'api' / (endpoint + '.py')).is_file())

    def test_insecure_database_url_is_rejected(self):
        with self.assertRaises(Rejected):
            RedisCounter('http://test.upstash.io', 'test-token')
