import concurrent.futures
import http.client
import json
import sqlite3
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Counter, Rejected, make_server


class CounterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temp.name) / 'count.sqlite3')
        self.counter = Counter(self.database)

    def tearDown(self):
        self.counter.db.close()
        self.temp.cleanup()

    def test_zero_reservation_and_reads_do_not_count(self):
        self.assertEqual(self.counter.total(), 0)
        self.counter.ticket()
        self.assertEqual(self.counter.total(), 0)

    def test_success_duplicates_and_parallel_completion(self):
        token = self.counter.ticket()
        with concurrent.futures.ThreadPoolExecutor(8) as executor:
            self.assertEqual(list(executor.map(self.counter.complete, [token] * 20)), [1] * 20)
        self.assertEqual(self.counter.complete(self.counter.ticket()), 2)

    def test_separate_users_share_atomic_total(self):
        tokens = [self.counter.ticket() for _ in range(20)]
        with concurrent.futures.ThreadPoolExecutor(8) as executor:
            list(executor.map(self.counter.complete, tokens))
        self.assertEqual(self.counter.total(), 20)

    def test_restart_preserves_count_rejects_old_tokens(self):
        token = self.counter.ticket()
        self.counter.complete(token)
        self.counter.db.close()
        self.counter = Counter(self.database)
        self.assertEqual(self.counter.total(), 1)
        with self.assertRaises(Rejected):
            self.counter.complete(token)
        self.assertEqual(self.counter.total(), 1)

    def test_rate_limit_and_expiry(self):
        now = [0]
        self.counter.clock = lambda: now[0]
        self.counter.limit = 2
        token = self.counter.ticket()
        self.counter.ticket()
        with self.assertRaises(Rejected) as caught:
            self.counter.ticket()
        self.assertEqual(caught.exception.status, 429)
        now[0] = 61
        self.counter.ticket()
        now[0] = 1900
        with self.assertRaises(Rejected):
            self.counter.complete(token)
        self.assertEqual(self.counter.total(), 0)

    def test_database_contains_only_aggregate(self):
        self.counter.complete(self.counter.ticket())
        tables = self.counter.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        self.assertEqual(tables, [('aggregate',)])
        self.assertEqual(self.counter.db.execute('SELECT * FROM aggregate').fetchall(), [(1, 1, 0)])

    def test_download_requires_completion_and_counts_once(self):
        token = self.counter.ticket()
        with self.assertRaises(Rejected):
            self.counter.download(token)
        self.counter.complete(token)
        self.assertEqual(self.counter.stats(), {'total': 1, 'downloads': 0})
        with concurrent.futures.ThreadPoolExecutor(8) as executor:
            results = list(executor.map(self.counter.download, [token] * 20))
        self.assertTrue(all(value == {'total': 1, 'downloads': 1} for value in results))
        other = self.counter.ticket()
        self.counter.complete(other)
        self.counter.download(other)
        self.assertEqual(self.counter.stats(), {'total': 2, 'downloads': 2})
        self.counter.db.close()
        self.counter = Counter(self.database)
        self.assertEqual(self.counter.stats(), {'total': 2, 'downloads': 2})
        with self.assertRaises(Rejected):
            self.counter.download(token)

    def test_existing_database_migrates_without_reset(self):
        legacy = str(Path(self.temp.name) / 'legacy.sqlite3')
        with sqlite3.connect(legacy) as db:
            db.execute('CREATE TABLE aggregate (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)')
            db.execute('INSERT INTO aggregate VALUES (1, 42)')
        migrated = Counter(legacy)
        self.assertEqual(migrated.stats(), {'total': 42, 'downloads': 0})
        migrated.db.close()


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = make_server('127.0.0.1', 0, str(Path(self.temp.name) / 'count.sqlite3'), 'https://sounds.test')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.headers = {'Origin': 'https://sounds.test', 'Sec-Fetch-Site': 'same-origin',
                        'X-S4H-Request': 'conversion', 'Content-Type': 'application/json'}

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.server.counter.db.close()
        self.temp.cleanup()

    def request(self, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request('GET' if body is None else 'POST', path,
                     None if body is None else json.dumps(body), self.headers if headers is None else headers)
        response = conn.getresponse()
        status, data = response.status, response.read()
        conn.close()
        return status, data

    def test_routes_assets_and_private_files(self):
        for route in ['/', '/privacy', '/app', '/app/downloads', '/app/', '/styles.css', '/app.js', '/encoder-worker.js']:
            self.assertEqual(self.request(route)[0], 200, route)
        for route in ['/server.py', '/data/counter.sqlite3', '/.git/config', '/unknown']:
            status, data = self.request(route)
            self.assertEqual(status, 404)
            self.assertNotIn(b'git@', data)

    def test_api_complete_once_and_reload_no_increment(self):
        self.assertEqual(json.loads(self.request('/api/count')[1]), {'total': 0})
        token = json.loads(self.request('/api/ticket', {})[1])['token']
        for _ in range(3):
            self.assertEqual(json.loads(self.request('/api/complete', {'token': token})[1]), {'total': 1})
        self.request('/app')
        self.assertEqual(json.loads(self.request('/api/count')[1]), {'total': 1})

    def test_live_stats_and_download_api(self):
        self.assertEqual(json.loads(self.request('/api/stats')[1]), {'total': 0, 'downloads': 0})
        token = json.loads(self.request('/api/ticket', {})[1])['token']
        self.assertEqual(self.request('/api/download', {'token': token})[0], 409)
        self.request('/api/complete', {'token': token})
        self.assertEqual(self.request('/api/download', {'token': token}, {})[0], 403)
        for _ in range(3):
            self.assertEqual(json.loads(self.request('/api/download', {'token': token})[1]), {'total': 1, 'downloads': 1})
        for _ in range(3):
            self.assertEqual(json.loads(self.request('/api/stats')[1]), {'total': 1, 'downloads': 1})

    def test_cross_origin_missing_headers_and_invalid_schema(self):
        for headers in [{}, dict(self.headers, Origin='https://evil.test'),
                        dict(self.headers, **{'Sec-Fetch-Site': 'cross-site'}),
                        {k: v for k, v in self.headers.items() if k != 'X-S4H-Request'}]:
            self.assertEqual(self.request('/api/ticket', {}, headers)[0], 403)
        self.assertEqual(self.request('/api/ticket', {'filename': 'private.mp3'})[0], 400)
        self.assertEqual(self.request('/api/complete', {'token': 'x' * 43})[0], 409)
        self.assertEqual(self.request('/api/complete', {'token': 'x' * 43, 'audio': 'data'})[0], 400)
        self.assertEqual(self.request('/api/complete', {'token': 'x' * 1000})[0], 413)
        self.assertEqual(self.request('/api/complete', [1])[0], 400)
        self.assertEqual(self.server.counter.total(), 0)


if __name__ == '__main__':
    unittest.main()
