"""Shared anonymous counters for Vercel. Only aggregate totals are long-lived.

Random deduplication tokens expire after 30 minutes; a global limiter expires
within 60 seconds. No audio, filename, IP, or device identifier is accepted.
"""
import json
import os
import secrets
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from server import Rejected

TICKET_SCRIPT = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
redis.call('INCR', KEYS[1])
if used == 0 then redis.call('EXPIRE', KEYS[1], 60) end
redis.call('SET', KEYS[2], 'pending', 'EX', 1800)
return 1
"""
COMPLETE_SCRIPT = """
local state = redis.call('GET', KEYS[1])
if not state then return -1 end
if state == 'pending' then
  redis.call('HINCRBY', KEYS[2], 'total', 1)
  redis.call('SET', KEYS[1], 'complete', 'KEEPTTL')
end
return tonumber(redis.call('HGET', KEYS[2], 'total') or '0')
"""
DOWNLOAD_SCRIPT = """
local state = redis.call('GET', KEYS[1])
if not state or state == 'pending' then return {-1, -1} end
if state == 'complete' then
  redis.call('HINCRBY', KEYS[2], 'downloads', 1)
  redis.call('SET', KEYS[1], 'downloaded', 'KEEPTTL')
end
return {tonumber(redis.call('HGET', KEYS[2], 'total') or '0'),
        tonumber(redis.call('HGET', KEYS[2], 'downloads') or '0')}
"""


class RedisCounter:
    # A common hash tag keeps all keys in the same Redis cluster slot.
    PREFIX = '{s4h-sounds}:'

    def __init__(self, url=None, token=None, limit=None):
        self.url = url if url is not None else (os.environ.get('UPSTASH_REDIS_REST_URL') or os.environ.get('KV_REST_API_URL'))
        self.token = token if token is not None else (os.environ.get('UPSTASH_REDIS_REST_TOKEN') or os.environ.get('KV_REST_API_TOKEN'))
        if not self.url or not self.token:
            raise Rejected(503, 'Counter storage is not connected. Configure Upstash Redis in Vercel Storage.')
        parsed = urlsplit(self.url)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Rejected(503, 'Counter storage configuration is invalid.')
        try:
            self.limit = int(limit if limit is not None else os.environ.get('COUNTER_TICKETS_PER_MINUTE', '60'))
            if self.limit <= 0:
                raise ValueError()
        except ValueError:
            raise Rejected(503, 'Counter rate limit configuration is invalid.')

    def command(self, *args):
        request = urllib.request.Request(self.url.rstrip('/'), data=json.dumps(args).encode(), method='POST',
                                         headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                data = json.load(response)
            if not isinstance(data, dict) or 'error' in data or 'result' not in data:
                raise ValueError()
            return data['result']
        except (OSError, ValueError, urllib.error.URLError):
            # Never surface provider errors, request URLs or credentials.
            raise Rejected(503, 'Counter storage is temporarily unavailable.') from None

    def stats(self):
        values = self.command('HMGET', self.PREFIX + 'totals', 'total', 'downloads')
        try:
            total, downloads = [int(value or 0) for value in values]
            if total < 0 or downloads < 0:
                raise ValueError()
            return {'total': total, 'downloads': downloads}
        except (ValueError, TypeError):
            raise Rejected(503, 'Counter storage returned invalid totals.') from None

    def total(self):
        return self.stats()['total']

    def ticket(self):
        token = secrets.token_urlsafe(32)
        result = self.command('EVAL', TICKET_SCRIPT, 2, self.PREFIX + 'rate', self.PREFIX + 'ticket:' + token, self.limit)
        if result == 0:
            raise Rejected(429, 'Counter busy. Local conversion is still available.')
        if result != 1:
            raise Rejected(503, 'Unable to reserve a completion token.')
        return token

    def complete(self, token):
        total = self.command('EVAL', COMPLETE_SCRIPT, 2, self.PREFIX + 'ticket:' + token, self.PREFIX + 'totals')
        if total == -1:
            raise Rejected(409, 'Unknown or expired completion token.')
        return total

    def download(self, token):
        total, downloads = self.command('EVAL', DOWNLOAD_SCRIPT, 2, self.PREFIX + 'ticket:' + token, self.PREFIX + 'totals')
        if total == -1:
            raise Rejected(409, 'A valid completed export is required.')
        return {'total': total, 'downloads': downloads}
