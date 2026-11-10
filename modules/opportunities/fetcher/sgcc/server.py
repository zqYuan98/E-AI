"""Internal fetcher service: lists public SGCC notices and fetches + parses one notice file.

Standard library HTTP only. One asyncio loop thread drives Playwright; a lock
keeps one browser at a time. Responses follow FetcherNotice / FetcherResult in
../types.ts (snake_case keys).
"""

import asyncio
from contextlib import contextmanager
from dataclasses import replace
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from . import sources
from .contracts import CollectorError
from .parsing import parse_file

ADDRESS = ('0.0.0.0', 8000)
MAX_BODY = 16 * 1024
_DRAIN = 1024 * 1024  # unread request bytes discarded before an error reply
LOCK_WAIT = 300
TIMEOUTS = {'discover': 150, 'fetch': 300}
MAX_WARNINGS = 50
_STATUS = {'bad_request': 400, 'unauthorized': 401, 'busy': 503, 'parse_error': 500, 'internal': 500}
_ITEM_FIELDS = ('batch', 'section', 'section_name', 'package', 'subpackage', 'package_name', 'project_name',
                'buyer', 'location', 'scope', 'qualifications', 'personnel', 'performance',
                'ceiling', 'ceiling_kind', 'budget', 'pricing')


def _bad_request(message, status=400):
    error = CollectorError('bad_request', message)
    error.status = status
    return error


def notice_json(notice):
    return {
        'source': notice.source, 'external_id': notice.external_id, 'url': notice.url, 'title': notice.title,
        'category': notice.category if notice.category in ('procurement', 'tender') else '',
        'buyer': notice.buyer, 'batch': notice.batch, 'published': notice.published,
        'metadata': {str(key): str(value) for key, value in notice.metadata.items()},
    }


def item_json(row):
    item = {name: getattr(row, name) for name in _ITEM_FIELDS}
    item['warnings'] = list(row.warnings)
    # Raw cells stay in the parser; callers only need the location in the original file.
    item['evidence'] = [{'file': e.file, 'sheet': e.sheet, 'row': e.row} for e in row.evidence]
    return item


def capped(warnings):
    if len(warnings) <= MAX_WARNINGS:
        return list(warnings)
    rest = len(warnings) - MAX_WARNINGS + 1
    return list(warnings[:MAX_WARNINGS - 1]) + [f'另有 {rest} 条警告未列出。']


TEXT_CHARS = 30000
GOODS_NAMES = 12


def notice_text(files):
    """Word 公告的正文：平台从里面抽通用资格、业绩要求和时间；附件里没有需求表时也靠它把整份公告当一个项目判断。"""
    text = ' '.join(f.text for f in files if getattr(f, 'text', ''))
    text = re.sub(r'\[word/[^\]\s]+\.xml\]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:TEXT_CHARS]


def _distinct(values, limit):
    seen = list(dict.fromkeys(v.strip() for v in values if v and v.strip() not in ('', '/')))
    return seen[:limit], len(seen)


def _goods_unit(rows):
    first = rows[0]
    sheets, _ = _distinct([r.evidence[0].sheet for r in rows], 3)
    names, total = _distinct([r.scope for r in rows], GOODS_NAMES)
    buyers, buyer_count = _distinct([r.buyer for r in rows], 3)
    places, place_count = _distinct([r.location for r in rows], 3)
    generic = not sheets or any(re.search(r'清单|^sheet\d*$', s, re.I) for s in sheets)
    if generic and names:
        name = names[0] + (f' 等 {total} 种物资' if total > 1 else '')
    else:
        name = '、'.join(sheets) or first.project_name
    scope = ('物资：' + '；'.join(names) + (f' 等 {total} 种' if total > len(names) else '') if names else '') + f'（货物清单 {len(rows)} 行）'
    ceilings = {(r.ceiling, r.ceiling_kind) for r in rows}
    ceiling, kind = ceilings.pop() if len(ceilings) == 1 else ('', 'unknown')
    warnings = list(dict.fromkeys(w for r in rows for w in r.warnings))[:5]
    return replace(first, subpackage='', project_name=name, scope=scope, ceiling=ceiling, ceiling_kind=kind,
                   buyer='、'.join(buyers) + ('等' if buyer_count > 3 else ''),
                   location='、'.join(places) + ('等' if place_count > 3 else ''),
                   request_id='', technical_id='', evidence=[r.evidence[0] for r in rows[:4]], warnings=warnings)


def bid_units(rows):
    """货物清单（物资框架、批次物资招标）一行是一种物资，一份公告几千行；投标按分标+包投，合成一包一条：
    名称用工作表名（物资类别），采购内容列出物资名称。和需求表对上的货物行已经并进需求行，不在这里。"""
    order, groups = [], {}
    for row in rows:
        if not row.evidence or (row.evidence[0].raw or {}).get('view') != 'goods':
            order.append(row)
            continue
        key = (row.section, row.package)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)
    return [_goods_unit(groups[x]) if isinstance(x, tuple) else x for x in order]


def display_name(filename):
    # Evidence shows this name; the saved file name is a random local name.
    suffix = Path(filename).suffix.lower()
    return '公告文件' + {'.ole': '.xls'}.get(suffix, suffix)


def log(**fields):
    print(json.dumps(fields, ensure_ascii=False), file=sys.stderr, flush=True)


class Service:
    def __init__(self, discover=None, download=None, parse=None, lock_wait=LOCK_WAIT, timeouts=None):
        self._discover = discover or sources.discover
        self._download = download or sources.download_notice
        self._parse = parse or parse_file
        self._lock_wait = lock_wait
        self._timeouts = timeouts or TIMEOUTS
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        threading.Thread(target=self._loop.run_forever, name='browser-loop', daemon=True).start()

    @contextmanager
    def _job(self):
        if not self._lock.acquire(timeout=self._lock_wait):
            raise CollectorError('busy', '采集服务正忙，请稍后再试。', retryable=True)
        try:
            yield
        finally:
            self._lock.release()

    def _run(self, factory, timeout):
        async def bounded():
            return await asyncio.wait_for(factory(), timeout)

        future = asyncio.run_coroutine_threadsafe(bounded(), self._loop)
        try:
            # The inner wait_for normally ends first and also closes the browser.
            return future.result(timeout + 30)
        except TimeoutError:
            future.cancel()
            raise CollectorError('network', '来源处理超时；未自动重试。', retryable=True) from None

    def discover(self, body):
        if set(body) - {'source', 'category', 'limit'}:
            raise _bad_request('只接受 source、category、limit。')
        source, category, limit = body.get('source'), body.get('category'), body.get('limit', 10)
        if source not in ('ecp', 'etp') or category not in ('procurement', 'tender'):
            raise _bad_request('source 须为 ecp 或 etp，category 须为 procurement 或 tender。')
        if type(limit) is not int or not 1 <= limit <= 20:
            raise _bad_request('limit 须为 1 至 20 的整数。')
        with self._job():
            notices = self._run(lambda: self._discover(source, category, limit), self._timeouts['discover'])
        return {'notices': [notice_json(notice) for notice in notices]}

    def fetch(self, body):
        if set(body) != {'url'} or not isinstance(body['url'], str):
            raise _bad_request('只接受 {"url": 公告详情链接}。')
        url = body['url']
        try:
            sources.validate_notice_url(url)
        except CollectorError as error:
            raise _bad_request(str(error)) from None
        directory = Path(tempfile.mkdtemp(prefix='sgcc-fetch-'))
        try:
            with self._job():
                downloaded = self._run(lambda: self._download(url, directory), self._timeouts['fetch'])
                try:
                    result = self._parse(downloaded.path, display_name(downloaded.filename))
                except Exception as error:
                    raise CollectorError('parse_error', f'附件解析失败（{type(error).__name__}）。') from None
            return {
                'notice': notice_json(downloaded.notice), 'sha256': downloaded.sha256,
                'complete': bool(result.complete), 'warnings': capped(result.warnings),
                'items': [item_json(row) for row in bid_units(result.rows)],
                'text': notice_text(result.files),
            }
        finally:
            shutil.rmtree(directory, ignore_errors=True)


def _source_of(kind, body):
    if kind == 'discover':
        return body.get('source') if body.get('source') in ('ecp', 'etp') else ''
    url = body.get('url')
    host = urlsplit(url).hostname if isinstance(url, str) else None
    return {'ecp.sgcc.com.cn': 'ecp', 'sgccetp.com.cn': 'etp'}.get(host, '')


class Handler(BaseHTTPRequestHandler):
    server_version = 'fetcher'
    sys_version = ''
    timeout = 30  # reading the request; job time limits are separate
    _body_read = False

    def log_message(self, format, *args):
        pass  # one JSON line per job instead; never request lines or headers

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _discard_body(self):
        # Closing with unread request bytes resets the connection before the client reads the reply.
        if self._body_read:
            return
        self._body_read = True
        length = self.headers.get('Content-Length', '')
        remaining = int(length) if length.isdigit() and int(length) <= _DRAIN else 0
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                break
            remaining -= len(chunk)

    def _error(self, error):
        code = getattr(error, 'code', 'internal')
        self.close_connection = True
        self._discard_body()
        self._send(getattr(error, 'status', None) or _STATUS.get(code, 502), {'error': {
            'code': code, 'message': str(error), 'retryable': bool(getattr(error, 'retryable', False)),
        }})

    def _authorized(self):
        expected = ('Bearer ' + self.server.token).encode()
        given = (self.headers.get('Authorization') or '').encode('utf-8', 'replace')
        if hmac.compare_digest(given, expected):
            return True
        self._error(CollectorError('unauthorized', '缺少或错误的访问令牌。'))
        return False

    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise _bad_request('请求体必须带 Content-Length。')
        length = self.headers.get('Content-Length', '')
        if not length.isdigit():
            raise _bad_request('请求体必须带 Content-Length。')
        if int(length) > MAX_BODY:
            raise _bad_request('请求体超过 16 KiB。', 413)
        try:
            self._body_read = True
            body = json.loads(self.rfile.read(int(length)).decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise _bad_request('请求体不是 JSON。') from None
        if not isinstance(body, dict):
            raise _bad_request('请求体必须是 JSON 对象。')
        return body

    def do_GET(self):
        if urlsplit(self.path).path != '/health':
            return self._error(_bad_request('没有这个接口。', 404))
        if self._authorized():
            self._send(200, {'ok': True})

    def do_POST(self):
        kind = urlsplit(self.path).path.lstrip('/')
        if kind not in ('discover', 'fetch'):
            return self._error(_bad_request('没有这个接口。', 404))
        started = time.monotonic()
        body = {}
        entry = {'kind': kind}
        try:
            if not self._authorized():
                entry.update(ok=False, error='unauthorized')
                return
            body = self._body()
            service = self.server.service
            payload = service.discover(body) if kind == 'discover' else service.fetch(body)
            entry['ok'] = True
            if kind == 'discover':
                entry['notices'] = len(payload['notices'])
            else:
                entry.update(items=len(payload['items']), warnings=len(payload['warnings']),
                             complete=payload['complete'])
            self._send(200, payload)
        except CollectorError as error:
            entry.update(ok=False, error=error.code)
            self._error(error)
        except Exception as error:
            entry.update(ok=False, error='internal', type=type(error).__name__)
            self._error(CollectorError('internal', '采集服务内部错误。'))
        finally:
            entry['source'] = _source_of(kind, body)
            entry['ms'] = round((time.monotonic() - started) * 1000)
            log(**entry)

    def _not_allowed(self):
        self._error(_bad_request('不支持此方法。', 405))

    do_PUT = do_DELETE = do_PATCH = _not_allowed


def make_server(token, service, address=ADDRESS):
    server = ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    server.token = token
    server.service = service
    return server


def main():
    token = os.environ.get('FETCHER_TOKEN', '')
    if not re.fullmatch(r'[\x21-\x7e]{24,}', token):
        print('FETCHER_TOKEN 未设置，或少于 24 个可见 ASCII 字符；拒绝启动。', file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server = make_server(token, Service())
    log(event='listening', port=ADDRESS[1])
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
