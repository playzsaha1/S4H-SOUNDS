"""Vercel HTTP adapter; never creates SQLite files or process-local tokens."""
import os
from urllib.parse import urlsplit

from backend.redis_counter import RedisCounter
from server import Handler


class handler(Handler):
    @property
    def counter(self):
        return RedisCounter()

    @property
    def origin(self):
        return os.environ.get('PUBLIC_ORIGIN', 'https://s4h-sounds.vercel.app').rstrip('/')

    def do_GET(self):
        # Functions serve only JSON endpoints, not arbitrary repository files.
        if urlsplit(self.path).path not in ('/api/stats', '/api/count'):
            self.send(405, {'error': 'Method not allowed.'})
            return
        super().do_GET()
