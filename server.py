"""Single-instance S4H-SOUNDS server. SQLite persists ONLY aggregate counts."""
import json
import os
import secrets
import sqlite3
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


class Rejected(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Counter:
    TTL = 1800

    def __init__(self, database, limit=60, clock=time.monotonic):
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(database, check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS aggregate (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL CHECK(total>=0))')
        # Migrate existing totals without resetting conversion history.
        columns = {row[1] for row in self.db.execute('PRAGMA table_info(aggregate)')}
        if 'downloads' not in columns:
            self.db.execute('ALTER TABLE aggregate ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0 CHECK(downloads>=0)')
        self.db.execute('INSERT OR IGNORE INTO aggregate (id, total, downloads) VALUES (1, 0, 0)')
        self.db.commit()
        self.lock = threading.Lock()
        self.tokens = {}  # random token -> [expiry, completed, download_requested]; never persisted
        self.requests = deque()  # aggregate timestamps, no user or IP keys
        self.limit, self.clock = limit, clock

    def total(self):
        with self.lock:
            return self.db.execute('SELECT total FROM aggregate WHERE id=1').fetchone()[0]

    def stats(self):
        with self.lock:
            total, downloads = self.db.execute('SELECT total, downloads FROM aggregate WHERE id=1').fetchone()
            return {'total': total, 'downloads': downloads}

    def download(self, token):
        with self.lock:
            value = self.tokens.get(token)
            if not value or value[0] <= self.clock() or not value[1]:
                raise Rejected(409, 'A valid completed export is required.')
            if not value[2]:
                with self.db:
                    self.db.execute('UPDATE aggregate SET downloads=downloads+1 WHERE id=1')
                value[2] = True
            total, downloads = self.db.execute('SELECT total, downloads FROM aggregate WHERE id=1').fetchone()
            return {'total': total, 'downloads': downloads}

    def ticket(self):
        with self.lock:
            now = self.clock()
            self.tokens = {token: value for token, value in self.tokens.items() if value[0] > now}
            while self.requests and self.requests[0] <= now - 60:
                self.requests.popleft()
            if len(self.requests) >= self.limit or len(self.tokens) >= 2000:
                raise Rejected(429, 'Counter busy. Local conversion is still available.')
            self.requests.append(now)
            token = secrets.token_urlsafe(32)
            self.tokens[token] = [now + self.TTL, False, False]
            return token

    def complete(self, token):
        with self.lock:
            value = self.tokens.get(token)
            if not value or value[0] <= self.clock():
                raise Rejected(409, 'Unknown or expired completion token.')
            if not value[1]:
                with self.db:
                    self.db.execute('UPDATE aggregate SET total=total+1 WHERE id=1')
                value[1] = True
            return self.db.execute('SELECT total FROM aggregate WHERE id=1').fetchone()[0]


class Handler(BaseHTTPRequestHandler):
    @property
    def counter(self):
        return self.server.counter

    @property
    def origin(self):
        return self.server.origin

    # Do not record IP addresses, paths, headers, or request bodies in access logs.
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send(self, status, body, content_type='application/json'):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        if status == 429:
            self.send_header('Retry-After', '60')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/api/count', '/api/stats'):
            try:
                self.send(200, self.counter.stats() if path == '/api/stats' else {'total': self.counter.total()})
            except Rejected as error:
                self.send(error.status, {'error': error.message})
            except sqlite3.Error:
                self.send(503, {'error': 'Counter unavailable.'})
            return
        routes = {'/', '/privacy', '/app', '/app/downloads'}
        normalized = path.rstrip('/') or '/'
        assets = {'/styles.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/encoder-worker.js': 'text/javascript; charset=utf-8'}
        if normalized in routes:
            self.send(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        elif path in assets:
            self.send(200, (ROOT / path[1:]).read_bytes(), assets[path])
        elif path.startswith('/api/'):
            self.send(404, {'error': 'Not found.'})
        else:
            self.send(404, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')

    def do_POST(self):
        try:
            if self.path not in ('/api/ticket', '/api/complete', '/api/download'):
                raise Rejected(404, 'Not found.')
            # Fixed configured origin; never trust arbitrary Host or forwarded headers.
            if self.headers.get('Origin') != self.origin:
                raise Rejected(403, 'Same-origin requests required.')
            if self.headers.get('Sec-Fetch-Site') != 'same-origin' or self.headers.get('X-S4H-Request') != 'conversion':
                raise Rejected(403, 'Application request required.')
            if self.headers.get('Content-Type') != 'application/json' or self.headers.get('Transfer-Encoding'):
                raise Rejected(415, 'JSON required.')
            try:
                length = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                raise Rejected(400, 'Invalid request length.')
            if not 0 <= length <= 128:
                raise Rejected(413, 'Request exceeds the counter schema.')
            try:
                data = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise Rejected(400, 'Invalid JSON.')
            if not isinstance(data, dict):
                raise Rejected(400, 'JSON object required.')
            if self.path == '/api/ticket':
                if data:
                    raise Rejected(400, 'Ticket requests accept no data.')
                self.send(200, {'token': self.counter.ticket()})
            else:
                if set(data) != {'token'} or not isinstance(data['token'], str) or len(data['token']) != 43:
                    raise Rejected(400, 'Only a completion token is accepted.')
                if self.path == '/api/download':
                    self.send(200, self.counter.download(data['token']))
                else:
                    self.send(200, {'total': self.counter.complete(data['token'])})
        except Rejected as error:
            self.send(error.status, {'error': error.message})
        except (sqlite3.Error, OSError):
            self.send(503, {'error': 'Counter unavailable.'})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Avoid the default traceback containing a client IP address.
        pass


def make_server(host, port, database, origin, limit=60):
    server = Server((host, port), Handler)
    server.counter = Counter(database, limit)
    server.origin = origin
    return server


if __name__ == '__main__':
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '8000'))
    origin = os.environ.get('PUBLIC_ORIGIN', f'http://localhost:{port}').rstrip('/')
    if urlsplit(origin).scheme not in ('http', 'https') or not urlsplit(origin).netloc:
        raise SystemExit('PUBLIC_ORIGIN must be an absolute HTTP(S) origin.')
    server = make_server(host, port, os.environ.get('COUNTER_DB', str(ROOT / 'data' / 'counter.sqlite3')), origin,
                         int(os.environ.get('COUNTER_TICKETS_PER_MINUTE', '60')))
    print(f'S4H-SOUNDS listening at {origin}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.counter.db.close()
