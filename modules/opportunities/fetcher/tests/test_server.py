"""HTTP contract of the fetcher. Fakes stand in for the browser and parser."""
import http.client
import json
from pathlib import Path
import threading
import time

import pytest

from sgcc import server
from sgcc.contracts import (CollectorError, DownloadedNotice, Evidence, Notice, ParsedFile, ParseResult, ProjectRow)

TOKEN = 'test-token-0123456789abcdefXYZ'
ECP = 'https://ecp.sgcc.com.cn/ecp2.0/portal/#/doc/doci-bid/123456_2018032900295987'


def notice(**changes):
    values = dict(source='ecp', external_id='123456_2018032900295987', url=ECP, title='示例采购批次',
                  category='procurement', buyer='采购单位', batch='001-A', published='2031-01-02',
                  deadline='', metadata={'procurement_file_deadline': '2031-01-05 12:00:00',
                                         'opening_time': '2031-01-10 09:00:00', 'batch_name': '示例采购批次'})
    values.update(changes)
    return Notice(**values)


def project_row(name='视频监控运维'):
    return ProjectRow(
        batch='001-A', section='S1', section_name='服务', package='包1', subpackage='/', package_name='运维',
        project_name=name, buyer='采购单位', scope='设备维护', qualifications='见公告', personnel='/',
        performance='同类业绩', location='原文地点', deadline='', ceiling='12', ceiling_kind='amount_wan',
        budget='', pricing='总价报价', request_id='R1', technical_id='T1', consortium='否',
        evidence=[Evidence('公告文件.zip!/需求.xlsx', '服务', 2, {'project_name': 'G2'}, {'cells': {'G2': {'v': 'secret'}}}),
                  Evidence('公告文件.zip!/货物.xlsx', '清单', 5)],
        warnings=['完整采购条件仍需核实'],
    )


class Fakes:
    def __init__(self):
        self.calls = []
        self.directories = []
        self.error = None
        self.parse_error = None
        self.rows = [project_row()]
        self.warnings = ['w'] * 3
        self.hold = None

    async def discover(self, source, category, limit):
        self.calls.append(('discover', source, category, limit))
        if self.error:
            raise self.error
        return [notice(category=category, metadata={'published_by': '发布单位', 'discovery': 'public_category_list'})]

    async def download(self, url, directory):
        self.calls.append(('download', url))
        self.directories.append(Path(directory))
        if self.hold:
            self.hold.wait(5)
        if self.error:
            raise self.error
        path = Path(directory) / ('ecp-' + 'a' * 32 + '.zip')
        path.write_bytes(b'PK\x03\x04fixture')
        return DownloadedNotice(notice(), str(path), path.name, 'f' * 64, 'playwright_public_announcement')

    def parse(self, path, filename):
        self.calls.append(('parse', Path(path).name, filename))
        if self.parse_error:
            raise self.parse_error
        return ParseResult(rows=self.rows, warnings=self.warnings, complete=True)


@pytest.fixture
def fakes():
    return Fakes()


@pytest.fixture
def service(fakes):
    return server.Service(discover=fakes.discover, download=fakes.download, parse=fakes.parse, lock_wait=0.2)


@pytest.fixture
def base(service, capsys):
    httpd = server.make_server(TOKEN, service, ('127.0.0.1', 0))
    thread = threading.Thread(target=httpd.serve_forever, args=(0.02,), daemon=True)
    thread.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def call(port, method, path, body=None, token=TOKEN, raw=None, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    sent = {'Authorization': 'Bearer ' + token} if token else {}
    sent.update(headers or {})
    connection.request(method, path, body=data, headers=sent)
    response = connection.getresponse()
    payload = json.loads(response.read() or b'null')
    connection.close()
    return response.status, payload


def test_health_requires_token(base):
    assert call(base, 'GET', '/health') == (200, {'ok': True})
    status, payload = call(base, 'GET', '/health', token=None)
    assert status == 401 and payload['error']['code'] == 'unauthorized'


@pytest.mark.parametrize('token', [None, 'wrong-token-0123456789abcdefXYZ', TOKEN + 'x'])
def test_jobs_require_exact_bearer_token(base, fakes, token):
    status, payload = call(base, 'POST', '/fetch', {'url': ECP}, token=token)
    assert status == 401 and payload['error']['code'] == 'unauthorized'
    assert fakes.calls == []


def test_unknown_routes_and_methods(base):
    assert call(base, 'GET', '/fetch')[0] == 404
    assert call(base, 'POST', '/other', {})[0] == 404
    assert call(base, 'DELETE', '/fetch')[0] == 405


def test_body_must_be_small_json_object(base, fakes):
    status, payload = call(base, 'POST', '/fetch', raw=b'{"url": "' + b'x' * (16 * 1024) + b'"}')
    assert status == 413 and payload['error']['code'] == 'bad_request'
    assert call(base, 'POST', '/fetch', raw=b'not json')[0] == 400
    assert call(base, 'POST', '/fetch', raw=b'[]')[0] == 400
    assert fakes.calls == []


@pytest.mark.parametrize(('path', 'body'), [
    ('/discover', {'source': 'other', 'category': 'tender'}),
    ('/discover', {'source': 'ecp', 'category': 'winners'}),
    ('/discover', {'source': 'ecp', 'category': 'tender', 'limit': 0}),
    ('/discover', {'source': 'ecp', 'category': 'tender', 'limit': 21}),
    ('/discover', {'source': 'ecp', 'category': 'tender', 'limit': True}),
    ('/discover', {'source': 'ecp', 'category': 'tender', 'extra': 1}),
    ('/fetch', {}),
    ('/fetch', {'url': 'https://ecp.sgcc.com.cn.attacker.invalid/ecp2.0/portal/#/doc/doci-bid/1_2'}),
    ('/fetch', {'url': ECP, 'path': '/etc/passwd'}),
])
def test_invalid_requests_never_reach_the_browser(base, fakes, path, body):
    status, payload = call(base, 'POST', path, body)
    assert status == 400 and payload['error'] == {**payload['error'], 'code': 'bad_request', 'retryable': False}
    assert fakes.calls == []


def test_discover_returns_fetcher_notices(base, fakes):
    status, payload = call(base, 'POST', '/discover', {'source': 'ecp', 'category': 'tender', 'limit': 5})
    assert status == 200
    assert fakes.calls == [('discover', 'ecp', 'tender', 5)]
    assert payload == {'notices': [{
        'source': 'ecp', 'external_id': '123456_2018032900295987', 'url': ECP, 'title': '示例采购批次',
        'category': 'tender', 'buyer': '采购单位', 'batch': '001-A', 'published': '2031-01-02',
        'metadata': {'published_by': '发布单位', 'discovery': 'public_category_list'},
    }]}


def test_fetch_maps_rows_slims_evidence_and_removes_temp_dir(base, fakes):
    status, payload = call(base, 'POST', '/fetch', {'url': ECP})
    assert status == 200
    assert set(payload) == {'notice', 'sha256', 'complete', 'warnings', 'items', 'text'}
    assert payload['sha256'] == 'f' * 64 and payload['complete'] is True and payload['warnings'] == ['w'] * 3
    assert 'deadline' not in payload['notice']
    assert payload['notice']['metadata']['procurement_file_deadline'] == '2031-01-05 12:00:00'
    assert payload['notice']['metadata']['opening_time'] == '2031-01-10 09:00:00'
    item = payload['items'][0]
    assert set(item) == set(server._ITEM_FIELDS) | {'warnings', 'evidence'}
    assert 'request_id' not in item and item['ceiling_kind'] == 'amount_wan'
    assert item['evidence'] == [{'file': '公告文件.zip!/需求.xlsx', 'sheet': '服务', 'row': 2},
                                {'file': '公告文件.zip!/货物.xlsx', 'sheet': '清单', 'row': 5}]
    assert item['warnings'] == ['完整采购条件仍需核实']
    # The parser sees a readable display name, never the remote one.
    assert fakes.calls[-1] == ('parse', 'ecp-' + 'a' * 32 + '.zip', '公告文件.zip')
    assert not fakes.directories[0].exists()


def test_word_text_excerpt_is_returned_for_notices_without_a_demand_sheet(base, fakes):
    # 附件里只有 Word 公告、没有需求表时，平台靠这段正文把整份公告当一个项目判断。
    fakes.rows = []
    word = ParsedFile('公告文件.zip!/采购公告.docx', 'a' * 64, 'docx', 'parsed', 10, text='视觉及环境采集系统\n\n框架采购  ' + '说明' * 2000)
    original = fakes.parse
    fakes.parse = lambda path, filename: ParseResult(rows=[], files=[word], complete=True)
    service = server.Service(discover=fakes.discover, download=fakes.download, parse=fakes.parse, lock_wait=0.2)
    payload = service.fetch({'url': ECP})
    fakes.parse = original
    assert payload['items'] == []
    assert payload['text'].startswith('视觉及环境采集系统 框架采购 说明')
    assert len(payload['text']) == server.TEXT_CHARS


def test_warnings_are_capped(base, fakes):
    fakes.warnings = [f'w{n}' for n in range(80)]
    payload = call(base, 'POST', '/fetch', {'url': ECP})[1]
    assert len(payload['warnings']) == 50
    assert payload['warnings'][:49] == fakes.warnings[:49] and '31' in payload['warnings'][-1]


def test_display_name_for_ole():
    assert server.display_name('etp-' + 'a' * 32 + '.ole') == '公告文件.xls'
    assert server.display_name('ecp-' + 'a' * 32 + '.pdf') == '公告文件.pdf'


@pytest.mark.parametrize(('error', 'status', 'retryable'), [
    (CollectorError('needs_login', '需要登录'), 502, False),
    (CollectorError('captcha', '验证'), 502, False),
    (CollectorError('rate_limit', '频繁'), 502, False),
    (CollectorError('no_attachment', '没有附件'), 502, False),
    (CollectorError('unknown_layout', '结构变化'), 502, False),
    (CollectorError('network', '超时', retryable=True), 502, True),
])
def test_source_errors_keep_code_and_retryable(base, fakes, error, status, retryable):
    fakes.error = error
    response_status, payload = call(base, 'POST', '/fetch', {'url': ECP})
    assert response_status == status
    assert payload == {'error': {'code': error.code, 'message': str(error), 'retryable': retryable}}
    assert not fakes.directories[0].exists()


def test_parse_failure_and_unexpected_errors(base, fakes):
    fakes.parse_error = MemoryError()
    status, payload = call(base, 'POST', '/fetch', {'url': ECP})
    assert status == 500 and payload['error']['code'] == 'parse_error'
    fakes.parse_error = None
    fakes.error = RuntimeError('page body with cookie=secret')
    status, payload = call(base, 'POST', '/discover', {'source': 'etp', 'category': 'procurement'})
    assert status == 500 and payload['error']['code'] == 'internal'
    assert 'secret' not in json.dumps(payload)


def test_jobs_are_serialized_and_busy_after_lock_wait(base, fakes):
    fakes.hold = threading.Event()
    first = threading.Thread(target=call, args=(base, 'POST', '/fetch', {'url': ECP}))
    first.start()
    while not fakes.calls:
        time.sleep(0.01)
    status, payload = call(base, 'POST', '/discover', {'source': 'ecp', 'category': 'tender'})
    assert status == 503 and payload['error'] == {**payload['error'], 'code': 'busy', 'retryable': True}
    assert call(base, 'GET', '/health')[0] == 200  # health never waits for a job
    fakes.hold.set()
    first.join()
    assert [c[0] for c in fakes.calls] == ['download', 'parse']


def test_job_timeout_is_a_retryable_network_error(fakes):
    import asyncio

    async def slow(*args):
        await asyncio.sleep(5)

    service = server.Service(discover=slow, download=fakes.download, parse=fakes.parse,
                             timeouts={'discover': 0.05, 'fetch': 0.05})
    with pytest.raises(CollectorError) as error:
        service.discover({'source': 'ecp', 'category': 'tender'})
    assert error.value.code == 'network' and error.value.retryable


def test_one_json_log_line_per_job_without_secrets(base, fakes, capsys):
    call(base, 'POST', '/fetch', {'url': ECP})
    call(base, 'POST', '/fetch', {'url': ECP}, token='wrong-token-0123456789abcdefXYZ')
    lines = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [(line['kind'], line['source'], line['ok']) for line in lines] == [('fetch', 'ecp', True), ('fetch', '', False)]
    assert lines[0]['items'] == 1 and isinstance(lines[0]['ms'], int)
    assert lines[1]['error'] == 'unauthorized'
    assert TOKEN not in json.dumps(lines) and 'wrong-token' not in json.dumps(lines)


@pytest.mark.parametrize('token', ['', 'short-token', 'has space in a long token value', None])
def test_refuses_to_start_without_a_strong_token(monkeypatch, token):
    if token is None:
        monkeypatch.delenv('FETCHER_TOKEN', raising=False)
    else:
        monkeypatch.setenv('FETCHER_TOKEN', token)
    monkeypatch.setattr(server, 'make_server', lambda *a: pytest.fail('must not bind'))
    assert server.main() == 2
