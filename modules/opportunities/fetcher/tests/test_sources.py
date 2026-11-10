import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict
import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from sgcc import sources
from sgcc.contracts import CollectorError


ECP = 'https://ecp.sgcc.com.cn/ecp2.0/portal/#/doc/doci-bid/123456_2018032900295987'
ETP = 'https://sgccetp.com.cn/portal/#/doc/doci-bid/987654_2018032900295987_456789/old'


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.mark.parametrize(('url', 'identity'), [
    (ECP, ('ecp', '123456_2018032900295987')),
    (ETP, ('etp', '987654_2018032900295987_456789')),
    (ECP.replace('.cn/', '.cn:443/'), ('ecp', '123456_2018032900295987')),
])
def test_full_hash_identity(url, identity):
    assert sources.validate_notice_url(url) == identity
    changed = url.replace('123456_', '123457_').replace('987654_', '987655_')
    assert sources.validate_notice_url(changed) != identity


@pytest.mark.parametrize('url', [
    'https://ecp.sgcc.com.cn/ecp2.0/portal/#/',
    ECP.replace('https:', 'http:'), ECP.replace('.cn/', '.cn:8443/'),
    ECP.replace('ecp.sgcc.com.cn', 'ecp.sgcc.com.cn.attacker.invalid'),
    ECP.replace('ecp.sgcc.com.cn', '127.0.0.1'),
    ECP.replace('ecp.sgcc.com.cn', 'user:secret@ecp.sgcc.com.cn'),
    ECP.replace('ecp.sgcc.com.cn', '@ecp.sgcc.com.cn'),
    ECP.replace('/portal/', '/other/'), ECP.replace('/#', '/?next=x#'),
    ECP.replace('/doci-bid/', '/doci-win/'), ECP + '?redirect=x',
    ECP + '/../../private', ECP.replace('123456_', '%31%32%33_'),
    ECP.replace('123456_', '123456%2f_'), ECP + '\n', ECP.replace('/#', '\\#'),
    ETP.replace('/old', ''), ETP + '/1',
])
def test_reject_untrusted_or_unverified_urls(url):
    with pytest.raises(CollectorError) as error:
        sources.validate_notice_url(url)
    assert error.value.code == 'unknown_layout'


@pytest.mark.parametrize('url', [
    'https://ecp.sgcc.com.cn/ecp2.0/portal/app.js',
    'https://ecp.sgcc.com.cn/ecp2.0/ecpwcmcore/index/noteList?lh6RWoWu=0abc_DEF.ghi',
    # The portal's anti-bot script lives on a random same-host path.
    'https://ecp.sgcc.com.cn/wN8QR01HsLbZ/acRLbC1q9RHN.d07207d.js',
    'https://ecp.sgcc.com.cn:443/private',
])
def test_any_path_on_the_fixed_source_host_is_allowed(url):
    assert sources._allowed_request(url, 'ecp')
    assert sources._allowed_request('https://sgccetp.com.cn/wN8QR01HsLbZ/acRLbC1q9RHN.d07207d.js', 'etp')


@pytest.mark.parametrize('url', [
    'https://sgccetp.com.cn/portal/',  # the other fixed source
    'http://ecp.sgcc.com.cn/ecp2.0/portal/', 'https://ecp.sgcc.com.cn:8443/ecp2.0/portal/',
    'wss://ecp.sgcc.com.cn/socket', 'https://cdn.example.invalid/lib.js',
    'https://ecp.sgcc.com.cn.attacker.invalid/x.js', 'https://user:pw@ecp.sgcc.com.cn/x.js',
    'http://127.0.0.1/portal/', 'data:text/html,hi', 'https://ecp.sgcc.com.cn/a b',
    'https://ecp.sgcc.com.cn:bad/', None,
])
def test_other_hosts_schemes_and_ports_are_blocked(url):
    assert not sources._allowed_request(url, 'ecp')


def test_attachment_endpoint_must_be_same_host_download():
    assert sources._attachment_url('https://ecp.sgcc.com.cn/ecp2.0/ecpwcmcore//index/downLoadBid?lh6RWoWu=x', 'ecp')
    assert sources._attachment_url('https://sgccetp.com.cn/ecpwcmcore/index/downLoadBid', 'etp')
    assert not sources._attachment_url('https://sgccetp.com.cn/ecpwcmcore/index/downLoadBid', 'ecp')
    assert not sources._attachment_url('https://ecp.sgcc.com.cn/ecp2.0/ecpwcmcore/index/login', 'ecp')


def listing_record(source='ecp', identifier=123456):
    return {'id': identifier, 'noticeId': identifier, 'firstPageDocId': 456789,
            'doctype': 'doci-bid', 'title': '示例采购批次', 'code': '001-A',
            'noticePublishTime': '2031-01-02', 'publishOrgName': '发布单位',
            **({'bidOrg': '采购单位'} if source == 'etp' else {})}


def detail_value(identifier=123456):
    return {'fileFlag': '1', 'notice': {
        'ONLINE_BID_NOTICE_ID': identifier, 'PURPRJ_NAME': '示例采购批次',
        'PURPRJ_CODE': '001-A', 'BID_ORG': '采购单位', 'PUB_TIME': '2031-01-02',
        'NOTICE_TYPE_NAME': '采购公告', 'PUBLISH_ORG_NAME': '发布单位',
        'BIDBOOK_BUY_END_TIME': '2031-01-05 12:00:00', 'OPENBID_TIME': '2031-01-10 09:00:00',
    }}


def test_listing_transform_uses_notice_id_not_document_id():
    notice = sources._list_notice('ecp', 'procurement', listing_record())
    assert notice.url == ECP
    assert notice.external_id.startswith('123456_')
    assert notice.batch == '001-A'
    assert notice.buyer == ''  # publisher is not asserted to be the purchaser
    assert notice.deadline == ''
    record = listing_record('etp', 987654)
    assert sources._list_notice('etp', 'procurement', record).url == ETP


def test_detail_transform_preserves_time_semantics_and_no_invented_deadline():
    notice = sources._detail_notice(ECP, detail_value())
    data = asdict(notice)
    assert data['batch'] == '001-A'
    assert data['buyer'] == '采购单位'
    assert data['deadline'] == ''
    assert data['published'] == '2031-01-02'
    assert data['metadata']['opening_time'] == '2031-01-10 09:00:00'
    assert data['metadata']['procurement_file_deadline'] == '2031-01-05 12:00:00'
    empty = detail_value()
    empty['notice'].pop('PURPRJ_CODE')
    empty['notice'].pop('PUB_TIME')
    assert sources._detail_notice(ECP, empty).batch == ''
    assert sources._detail_notice(ECP, empty).published == ''


def test_refuse_mismatched_detail_and_wrong_list_category():
    with pytest.raises(CollectorError, match='不是所请求'):
        sources._detail_notice(ECP, detail_value(123457))
    record = listing_record()
    record['firstPageMenuId'] = 2018032700291334
    with pytest.raises(CollectorError):
        sources._list_notice('ecp', 'procurement', record)
    record['doctype'] = 'doci-win'
    with pytest.raises(CollectorError):
        sources._list_notice('ecp', 'tender', record)


@pytest.mark.parametrize(('text', 'status', 'code'), [
    ('请先登录', 200, 'needs_login'), ('购买后下载', 200, 'needs_login'),
    ('验证码', 200, 'captcha'), ('Access denied', 403, 'captcha'),
    ('', 429, 'rate_limit'), ('访问过于频繁', 200, 'rate_limit'),
    ('', 403, 'needs_login'),
])
def test_denial_codes_never_automatically_retry(text, status, code):
    error = sources._denial(text, status)
    assert error.code == code
    assert not error.retryable
    assert sources._denial('登录 注册 下载公告文件') is None


class Response:
    status = 200

    def __init__(self, value=None, text=''):
        self.value = value
        self.content = text

    async def json(self):
        if self.value is None:
            raise ValueError('not JSON')
        return self.value

    async def text(self):
        return self.content


def test_json_login_html_is_not_list_data():
    with pytest.raises(CollectorError) as error:
        run(sources._json_response(Response(text='<html>请先登录</html>')))
    assert error.value.code == 'needs_login'


@pytest.mark.parametrize('prefix', [b'<html>login required</html>', b'not a zip', b''])
def test_invalid_download_signatures(tmp_path, prefix):
    path = tmp_path / 'claims-to-be.zip'
    path.write_bytes(prefix)
    with pytest.raises(CollectorError) as error:
        sources._file_signature(path)
    assert error.value.code in ('needs_login', 'no_attachment')


def test_oversized_file_rejected_before_read(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, '_MAX_BYTES', 8)
    path = tmp_path / 'archive.zip'
    path.write_bytes(b'PK\x03\x04' + b'x' * 5)
    with pytest.raises(CollectorError) as error:
        sources._file_signature(path)
    assert error.value.code == 'no_attachment'


@pytest.mark.parametrize(('prefix', 'extension'), [
    (b'PK\x03\x04body', '.zip'), (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1body', '.ole'), (b'%PDF-1.7', '.pdf'),
])
def test_signature_not_remote_filename_controls_extension(tmp_path, prefix, extension):
    path = tmp_path / 'remote-name.exe'
    path.write_bytes(prefix)
    assert sources._file_signature(path) == extension


def test_fresh_directory_required(tmp_path):
    assert sources._fresh_directory(tmp_path) == tmp_path.resolve()
    (tmp_path / 'existing').write_text('keep')
    with pytest.raises(CollectorError):
        sources._fresh_directory(tmp_path)
    assert (tmp_path / 'existing').read_text() == 'keep'


def test_private_dns_resolution_fails_closed(monkeypatch):
    monkeypatch.setattr(sources.socket, 'getaddrinfo', lambda *a, **kw: [(2, 1, 6, '', ('127.0.0.1', 443))])
    with pytest.raises(CollectorError) as error:
        sources._public_address('ecp.sgcc.com.cn')
    assert error.value.code == 'network'


def fake_session(page):
    @asynccontextmanager
    async def session(source):
        yield SimpleNamespace(), SimpleNamespace(), page
    return session


def test_discovery_navigates_category_not_homepage(monkeypatch):
    urls = []
    monkeypatch.setattr(sources, '_session', fake_session(SimpleNamespace()))

    async def navigate(page, url, name):
        urls.append((url, name))
        return {'noteList': [listing_record(), listing_record(identifier=123457)], 'count': 2}

    monkeypatch.setattr(sources, '_navigate_response', navigate)
    notices = run(sources.discover('ecp', 'tender', 1))
    assert len(notices) == 1
    assert notices[0].category == 'tender'
    assert urls == [('https://ecp.sgcc.com.cn/ecp2.0/portal/#/list/list-spe/2018032600289606_1_2018032700291334', 'noteList')]


def test_discovery_deduplicates_and_bounds_pagination(monkeypatch):
    class Button:
        async def wait_for(self, **kwargs):
            pass

        async def is_disabled(self):
            return False

        async def click(self):
            page.clicks += 1

    class Page:
        clicks = 0

        def locator(self, name):
            return self

        def get_by_role(self, *args, **kwargs):
            return Button()

        @asynccontextmanager
        async def expect_response(self, predicate):
            async def result():
                return Response({'successful': True, 'resultValue': value})
            yield SimpleNamespace(value=result())

    page = Page()
    value = {'noteList': [listing_record(), listing_record()], 'count': 99}
    monkeypatch.setattr(sources, '_session', fake_session(page))

    async def navigate(*args):
        return value

    monkeypatch.setattr(sources, '_navigate_response', navigate)
    assert len(run(sources.discover('ecp', limit=2))) == 1
    assert page.clicks == 2


@pytest.mark.parametrize('arguments', [('unknown',), ('ecp', 'winners'), ('ecp', 'tender', 0), ('etp', 'procurement', 21)])
def test_discovery_rejects_invalid_inputs_before_browser(arguments):
    with pytest.raises(CollectorError):
        run(sources.discover(*arguments))


class DetailPage:
    def get_by_text(self, *args, **kwargs):
        return self

    async def wait_for(self, **kwargs):
        pass


def stub_detail(monkeypatch, value):
    monkeypatch.setattr(sources, '_session', fake_session(DetailPage()))

    async def navigate(*args):
        return value

    async def no_denial(*args):
        pass

    monkeypatch.setattr(sources, '_navigate_response', navigate)
    monkeypatch.setattr(sources, '_page_denial', no_denial)


def test_download_returns_dataclass_hash_and_safe_filename(tmp_path, monkeypatch):
    stub_detail(monkeypatch, detail_value())
    content = b'PK\x03\x04archive-content'

    async def download(context, page, source, directory):
        target = directory / ('ecp-' + 'a' * 32 + '.zip')
        target.write_bytes(content)
        return target

    monkeypatch.setattr(sources, '_download_file', download)
    result = run(sources.download_notice(ECP, tmp_path))
    assert Path(result.path).parent == tmp_path
    assert result.filename == 'ecp-' + 'a' * 32 + '.zip'
    assert result.sha256 == hashlib.sha256(content).hexdigest()
    assert asdict(result)['notice']['external_id'] == '123456_2018032900295987'


def test_missing_attachment_does_not_attempt_download(tmp_path, monkeypatch):
    value = detail_value()
    value['fileFlag'] = '0'
    stub_detail(monkeypatch, value)
    with pytest.raises(CollectorError) as error:
        run(sources.download_notice(ECP, tmp_path))
    assert error.value.code == 'no_attachment'
    assert list(tmp_path.iterdir()) == []


def test_failed_download_removes_partial_generated_files(tmp_path, monkeypatch):
    stub_detail(monkeypatch, detail_value())

    async def download(context, page, source, directory):
        (directory / ('ecp-' + 'b' * 32 + '.part')).write_bytes(b'partial')
        raise CollectorError('rate_limit', 'stop')

    monkeypatch.setattr(sources, '_download_file', download)
    with pytest.raises(CollectorError) as error:
        run(sources.download_notice(ECP, tmp_path))
    assert error.value.code == 'rate_limit'
    assert list(tmp_path.iterdir()) == []


class Emitter:
    def __init__(self):
        self.handlers = {}

    def on(self, name, callback):
        self.handlers.setdefault(name, []).append(callback)

    def remove_listener(self, name, callback):
        self.handlers[name].remove(callback)

    def emit(self, name, value):
        for callback in list(self.handlers.get(name, [])):
            callback(value)


class Frame:
    def __init__(self, text):
        self.text = text

    def locator(self, selector):
        return self

    async def inner_text(self, timeout=None):
        return self.text


class Popup(Emitter):
    def __init__(self, text=''):
        super().__init__()
        self.frames = [Frame(text)]
        self.closed = False

    def is_closed(self):
        return self.closed

    async def close(self):
        self.closed = True


class Download:
    def __init__(self, content=b'PK\x03\x04sample', url=None):
        self.content = content
        self.url = url or 'https://ecp.sgcc.com.cn/ecp2.0/ecpwcmcore/index/downLoadBid?lh6RWoWu=opaque'
        self.suggested_filename = '../../evil.py'
        self.saved = []
        self.canceled = self.deleted = False

    async def save_as(self, path):
        self.saved.append(Path(path))
        Path(path).write_bytes(self.content)

    async def failure(self):
        return None

    async def cancel(self):
        self.canceled = True

    async def delete(self):
        self.deleted = True


class SourcePage(Emitter):
    """The detail page: clicking the exact text opens a popup that downloads."""

    def __init__(self, context, popup, downloads=(), status=200, headers=None, on_original=False):
        super().__init__()
        self.context = context
        self.popup = popup
        self.downloads = list(downloads)
        self.status = status
        self.headers = headers or {}
        self.on_original = on_original
        self.frames = [Frame('')]
        self.clicked = []

    def is_closed(self):
        return False

    def get_by_text(self, text, exact=False):
        self.clicked.append((text, exact))
        return self

    async def click(self):
        assert self.clicked[-1] == ('下载公告文件', True)
        self.context.emit('page', self.popup)
        url = 'https://ecp.sgcc.com.cn/ecp2.0/ecpwcmcore/index/downLoadBid?lh6RWoWu=opaque'
        self.context.emit('response', SimpleNamespace(url=url, status=self.status, headers=self.headers))
        for download in self.downloads:
            (self if self.on_original else self.popup).emit('download', download)


def popup_download(tmp_path, **options):
    context, popup = Emitter(), Popup(options.pop('popup_text', ''))
    page = SourcePage(context, popup, **options)
    outcome = run(sources._download_file(context, page, 'ecp', tmp_path))
    return outcome, context, page, popup


def test_popup_download_saved_under_generated_name_and_popup_closed(tmp_path):
    download = Download()
    path, context, page, popup = popup_download(tmp_path, downloads=[download])
    assert path.parent == tmp_path
    assert sources._GENERATED.fullmatch(path.name) and path.suffix == '.zip'
    assert path.read_bytes() == download.content
    assert list(tmp_path.iterdir()) == [path]
    assert popup.closed and download.deleted
    assert all(not handlers for handlers in [*context.handlers.values(), *page.handlers.values()])


def test_download_on_the_original_page_is_also_accepted(tmp_path):
    path, *_ = popup_download(tmp_path, downloads=[Download(b'%PDF-1.7')], on_original=True)
    assert path.suffix == '.pdf'


def failed_download(tmp_path, **options):
    with pytest.raises(CollectorError) as error:
        popup_download(tmp_path, **options)
    assert not any(path.suffix in ('.zip', '.ole', '.pdf') for path in tmp_path.iterdir())
    return error.value


def test_declared_oversize_is_cancelled_before_saving(tmp_path):
    download = Download()
    error = failed_download(tmp_path, downloads=[download], headers={'content-length': str(50 * 1024 * 1024 + 1)})
    assert error.code == 'no_attachment'
    assert download.canceled and not download.saved


def test_undeclared_oversize_is_rejected_after_saving(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, '_MAX_BYTES', 8)
    assert failed_download(tmp_path, downloads=[Download(b'PK\x03\x04' + b'x' * 20)]).code == 'no_attachment'


@pytest.mark.parametrize(('content', 'code'), [
    (b'<html>login required</html>', 'needs_login'), (b'<html>error</html>', 'no_attachment'), (b'', 'no_attachment'),
])
def test_html_or_unknown_download_content_is_rejected(tmp_path, content, code):
    assert failed_download(tmp_path, downloads=[Download(content)]).code == code


def test_download_from_unexpected_target_is_cancelled(tmp_path):
    download = Download(url='https://sgccetp.com.cn/ecpwcmcore/index/downLoadBid')
    assert failed_download(tmp_path, downloads=[download]).code == 'unknown_layout'
    assert download.canceled and not download.saved


def test_two_downloads_from_one_click_stop(tmp_path):
    first, second = Download(), Download()
    assert failed_download(tmp_path, downloads=[first, second]).code == 'unknown_layout'
    assert first.canceled and second.canceled


@pytest.mark.parametrize(('status', 'code'), [(403, 'needs_login'), (429, 'rate_limit'), (500, 'network')])
def test_download_endpoint_error_status_is_classified(tmp_path, status, code):
    assert failed_download(tmp_path, status=status).code == code


def test_popup_login_page_without_download_is_a_denial(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, '_DOWNLOAD_TIMEOUT', 0.01)
    error = failed_download(tmp_path, popup_text='请先登录后下载')
    assert error.code == 'needs_login' and not error.retryable
    assert failed_download(tmp_path).code == 'network'
