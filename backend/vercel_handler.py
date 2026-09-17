"""Vercel HTTP adapter; never creates SQLite files or process-local tokens."""
import os
from urllib.parse import urlsplit

from backend.redis_counter import RedisCounter
from server import Handler


class handler(Handler):
    def _normalize_route(self):
        # The explicit Python builder exposes .py paths; rewrites can pass
        # either the source or destination path to the handler.
        path = urlsplit(self.path).path
        if path in ('/api/stats.py', '/api/count.py', '/api/ticket.py',
                    '/api/complete.py', '/api/download.py'):
            self.path = path[:-3]

    @property
    def counter(self):
        return RedisCounter()

    @property
    def origin(self):
        return os.environ.get('PUBLIC_ORIGIN', 'https://s4h-sounds.vercel.app').rstrip('/')

    def do_GET(self):
        self._normalize_route()
        # Functions serve only JSON endpoints, not arbitrary repository files.
        if urlsplit(self.path).path not in ('/api/stats', '/api/count'):
            self.send(405, {'error': 'Method not allowed.'})
            return
        super().do_GET()

    def do_POST(self):
        self._normalize_route()
        super().do_POST()
