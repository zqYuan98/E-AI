"""Fixed SGCC public announcement connectors; imports never start a browser."""

import asyncio
from contextlib import asynccontextmanager
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import socket
from urllib.parse import urlsplit
from uuid import uuid4

from .contracts import CollectorError, DownloadedNotice, Notice


_PORTALS = {
    'ecp': 'https://ecp.sgcc.com.cn/ecp2.0/portal/',
    'etp': 'https://sgccetp.com.cn/portal/',
}
_MENUS = {'procurement': '2018032900295987', 'tender': '2018032700291334'}
_MAX_BYTES = 50 * 1024 * 1024
_MAX_PAGES = 3
_TIMEOUT = 35_000
_DOWNLOAD_TIMEOUT = 90
_MAX_REQUEST_URL = 65536
_GENERATED = re.compile(r'(ecp|etp)-[0-9a-f]{32}\.(zip|ole|pdf|part)')


def _error(code, message):
    return CollectorError(code, message, retryable=code == 'network')


def _split_public_url(url):
    if not isinstance(url, str) or len(url) > 2048 or re.search(r'[\s\\\x00-\x1f\x7f]', url):
        raise _error('unknown_layout', '公告链接格式不正确。')
    try:
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            raise ValueError()
        if parsed.hostname not in ('ecp.sgcc.com.cn', 'sgccetp.com.cn'):
            raise ValueError()
        if any(part in ('.', '..') for part in parsed.path.split('/')):
            raise ValueError()
        return parsed
    except ValueError:
        raise _error('unknown_layout', '只接受两个固定国网来源的 HTTPS 公告链接。') from None


def validate_notice_url(url: str) -> tuple[str, str]:
    """Validate the route, including the hash; a shared portal root is not an ID."""
    parsed = _split_public_url(url)
    source = 'ecp' if parsed.hostname == 'ecp.sgcc.com.cn' else 'etp'
    if parsed.query or parsed.path != urlsplit(_PORTALS[source]).path:
        raise _error('unknown_layout', '不支持此公告路径或查询参数。')
    pattern = r'/doc/doci-bid/([0-9]{1,32}_[0-9]{1,32})'
    if source == 'etp':
        pattern = r'/doc/doci-bid/([0-9]{1,32}_[0-9]{1,32}_[0-9]{1,32})/old'
    match = re.fullmatch(pattern, parsed.fragment)
    if not match:
        raise _error('unknown_layout', '仅支持已验证的公开招标/采购公告详情链接。')
    return source, match.group(1)


def _allowed_request(url, source):
    """Any path on the fixed source host: the portal loads its anti-bot script
    from a random same-host path, and that script must run unmodified."""
    if not isinstance(url, str) or len(url) > _MAX_REQUEST_URL or re.search(r'[\s\x00-\x1f\x7f]', url):
        return False
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return False
    return (parsed.scheme == 'https' and parsed.username is None and parsed.password is None
            and parsed.hostname == urlsplit(_PORTALS[source]).hostname and port in (None, 443))


def _attachment_url(url, source):
    if not _allowed_request(url, source):
        return False
    return re.sub(r'/+', '/', urlsplit(url).path).endswith('/ecpwcmcore/index/downLoadBid')


def _endpoint(response, name):
    return urlsplit(response.url).path.endswith('/index/' + name)


def _denial(text, status=200):
    if status == 429 or re.search(r'访问过于频繁|请求过于频繁|操作(?:过于)?频繁|too many requests|rate limit', text, re.I):
        return _error('rate_limit', '来源限制访问频率；已停止，请人工确认后再试。')
    if re.search(r'验证码|滑块验证|人机验证|安全验证|captcha|verify you are human|access denied', text, re.I):
        return _error('captcha', '来源要求安全验证或拒绝访问；不会绕过。')
    if status in (401, 403) or re.search(r'请先登录|需要登录|登录后.*(?:下载|查看)|请登录后|购买后|无权访问|权限不足|sign in to|login required', text, re.I):
        return _error('needs_login', '该资源需要登录、授权或人工操作；不会登录或购买。')
    return None


async def _json_response(response):
    if response.status >= 400:
        raise _denial('', response.status) or _error('network', '来源接口返回错误状态。')
    try:
        payload = await response.json()
    except Exception:
        text = (await response.text())[:8192]
        raise _denial(text) or _error('unknown_layout', '来源没有返回已验证的公告数据结构。') from None
    if not isinstance(payload, dict):
        raise _error('unknown_layout', '来源公告数据结构已改变。')
    if payload.get('successful') is not True:
        hint = str(payload.get('resultHint') or '')
        raise _denial(hint) or _error('unknown_layout', '来源未成功返回公告数据；请在原站核对。')
    value = payload.get('resultValue')
    if not isinstance(value, dict):
        raise _error('unknown_layout', '来源公告结果结构已改变。')
    return value


def _text(value):
    return value.strip() if isinstance(value, str) else ''


def _identifier(value):
    text = str(value) if isinstance(value, (int, str)) and not isinstance(value, bool) else ''
    if not re.fullmatch(r'[0-9]{1,32}', text):
        raise _error('unknown_layout', '来源公告标识缺失或格式已改变。')
    return text


def _list_notice(source, category, record):
    if not isinstance(record, dict) or record.get('doctype') != 'doci-bid':
        raise _error('unknown_layout', '列表包含未支持的公告类型，不能当作采购公告处理。')
    menu = _MENUS[category]
    if record.get('firstPageMenuId') is not None and str(record['firstPageMenuId']) != menu:
        raise _error('unknown_layout', '列表栏目与请求栏目不一致。')
    identity = _identifier(record.get('noticeId'))
    if record.get('id') is not None and _identifier(record['id']) != identity:
        raise _error('unknown_layout', '列表公告标识不一致。')
    external_id = identity + '_' + menu
    if source == 'etp':
        external_id += '_' + _identifier(record.get('firstPageDocId'))
    url = _PORTALS[source] + '#/doc/doci-bid/' + external_id + ('/old' if source == 'etp' else '')
    validate_notice_url(url)
    title = _text(record.get('title'))
    if not title:
        raise _error('unknown_layout', '列表公告标题缺失。')
    return Notice(source=source, external_id=external_id, url=url, title=title,
                  category=category, buyer=_text(record.get('bidOrg')),
                  batch=_text(record.get('code')), published=_text(record.get('noticePublishTime')),
                  metadata={'published_by': _text(record.get('publishOrgName')), 'discovery': 'public_category_list'})


def _detail_notice(url, value):
    source, external_id = validate_notice_url(url)
    record = value.get('notice')
    if not isinstance(record, dict):
        raise _error('unknown_layout', '详情中没有公告字段。')
    if _identifier(record.get('ONLINE_BID_NOTICE_ID')) != external_id.split('_')[0]:
        raise _error('unknown_layout', '详情响应不是所请求的公告。')
    title = _text(record.get('TITLE')) or _text(record.get('PURPRJ_NAME'))
    if not title:
        raise _error('unknown_layout', '公告详情标题缺失。')
    notice_type = _text(record.get('NOTICE_TYPE_NAME'))
    category = next((name for name, menu in _MENUS.items() if external_id.split('_')[1] == menu), '')
    if not category:
        category = 'procurement' if notice_type == '采购公告' else 'tender' if '招标' in notice_type else ''
    fields = {'published_by': 'PUBLISH_ORG_NAME', 'batch_name': 'PURPRJ_NAME',
              'notice_type': 'NOTICE_TYPE_NAME', 'procurement_type': 'PUR_TYPE_NAME',
              'procurement_file_deadline': 'BIDBOOK_BUY_END_TIME',
              'procurement_file_start': 'BIDBOOK_SELL_BEGIN_TIME', 'opening_time': 'OPENBID_TIME'}
    metadata = {name: _text(record.get(key)) for name, key in fields.items() if _text(record.get(key))}
    # Opening time and file-acquisition deadline are not a stated bidding deadline.
    return Notice(source=source, external_id=external_id, url=url, title=title, category=category,
                  buyer=_text(record.get('BID_ORG')), batch=_text(record.get('PURPRJ_CODE')),
                  published=_text(record.get('PUB_TIME')), metadata=metadata)


def _public_address(host):
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(item).is_global for item in addresses):
            raise _error('network', '固定来源没有解析为公开网络地址，已停止。')
        address = sorted(addresses, key=lambda item: (':' in item, item))[0]
        return '[' + address + ']' if ':' in address else address
    except OSError:
        raise _error('network', '无法解析固定来源的公开地址。') from None


@asynccontextmanager
async def _session(source):
    from playwright.async_api import async_playwright, Error, TimeoutError as BrowserTimeout

    host = urlsplit(_PORTALS[source]).hostname
    address = await asyncio.to_thread(_public_address, host)
    browser = None
    page = None
    try:
        async with async_playwright() as playwright:
            options = {'headless': True, 'args': [
                '--no-proxy-server', '--disable-background-networking', '--disable-component-update',
                f'--host-resolver-rules=MAP {host} {address}, MAP * ~NOTFOUND',
            ]}
            executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
            if executable:
                options['executable_path'] = executable
            browser = await playwright.chromium.launch(**options)
            try:
                # Downloads are only taken from the explicit announcement click (see _download_file).
                context = await browser.new_context(accept_downloads=True, service_workers='block')

                async def route_request(route):
                    if _allowed_request(route.request.url, source):
                        await route.continue_()
                    else:
                        await route.abort('blockedbyclient')

                await context.route('**/*', route_request)
                await context.route_web_socket('**/*', lambda websocket: websocket.close())
                page = await context.new_page()
                page.set_default_timeout(_TIMEOUT)
                yield browser, context, page
            finally:
                await browser.close()
                browser = None
    except CollectorError:
        raise
    except (BrowserTimeout, asyncio.TimeoutError):
        raise _error('network', '等待公告响应或下载超时；未自动重试。') from None
    except Error:
        raise _error('network', '浏览器无法完成公开访问；请检查网络和 Chromium 安装。') from None
    except OSError:
        raise _error('network', '无法读取或保存浏览器下载文件；请检查目录和磁盘权限。') from None


async def _page_denial(page):
    # Login redirects can appear inside the announcement's download iframe or popup.
    if page.is_closed():
        return
    for frame in page.frames:
        text = (await frame.locator('body').inner_text(timeout=5000))[:20000]
        denial = _denial(text)
        if denial:
            raise denial


async def _navigate_response(page, url, name):
    from playwright.async_api import TimeoutError as BrowserTimeout

    try:
        async with page.expect_response(lambda response: _endpoint(response, name), timeout=_TIMEOUT) as response:
            navigation = await page.goto(url, wait_until='domcontentloaded', timeout=_TIMEOUT)
            if navigation is not None and navigation.status >= 400:
                raise _denial('', navigation.status) or _error('network', '来源页面返回错误状态。')
        return await _json_response(await response.value)
    except BrowserTimeout:
        await _page_denial(page)
        raise


async def discover(source: str, category: str = 'procurement', limit: int = 10) -> list[Notice]:
    if source not in _PORTALS or category not in _MENUS:
        raise _error('unknown_layout', '仅支持 ECP/ETP 的采购公告或招标公告栏目。')
    if type(limit) is not int or not 1 <= limit <= 20:
        raise _error('unknown_layout', '单轮公告数量必须为 1 至 20。')
    url = _PORTALS[source] + '#/list/list-spe/2018032600289606_1_' + _MENUS[category]
    if source == 'etp':
        url += '/old/1'
    found = {}
    async with _session(source) as (_, __, page):
        value = await _navigate_response(page, url, 'noteList')
        for page_number in range(1, _MAX_PAGES + 1):
            records = value.get('noteList')
            count = value.get('count')
            if not isinstance(records, list) or type(count) is not int or count < 0:
                raise _error('unknown_layout', '栏目列表结构已改变。')
            # 列表里混着变更、中标等其他类型的公告：跳过，只收采购/招标公告。一整页都认不出来才算格式变了。
            first_error = None
            for record in records:
                if not isinstance(record, dict) or record.get('doctype') != 'doci-bid':
                    continue
                try:
                    notice = _list_notice(source, category, record)
                except CollectorError as error:
                    first_error = first_error or error
                    continue
                found.setdefault(notice.external_id, notice)
                if len(found) == limit:
                    return list(found.values())
            if first_error is not None and not found:
                raise first_error
            if not records or len(found) >= count:
                return list(found.values())
            if page_number == _MAX_PAGES:
                break
            # Observed on both portals: page component, semantic button text >.
            next_page = page.locator('page').get_by_role('button', name='>', exact=True)
            await next_page.wait_for(state='visible')
            if await next_page.is_disabled():
                return list(found.values())
            async with page.expect_response(lambda response: _endpoint(response, 'noteList')) as response:
                await next_page.click()
            value = await _json_response(await response.value)
    return list(found.values())


def _fresh_directory(directory):
    path = Path(directory)
    if path.is_symlink() or not path.is_dir() or any(path.iterdir()):
        raise _error('unknown_layout', '下载目录必须是调用方新建的空目录，不能是符号链接。')
    return path.resolve()


def _file_signature(path):
    size = path.stat().st_size
    if not 0 < size <= _MAX_BYTES:
        raise _error('no_attachment', '公告文件为空或超过 50 MiB 限制。')
    with path.open('rb') as stream:
        prefix = stream.read(8192)
    if prefix.startswith((b'PK\x03\x04', b'PK\x05\x06')):
        return '.zip'
    if prefix.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        # CFB can be XLS or DOC; its container signature cannot distinguish them.
        return '.ole'
    if prefix.startswith(b'%PDF-'):
        return '.pdf'
    text = prefix.decode('utf-8', errors='replace')
    raise _denial(text) or _error('no_attachment', '下载内容不是支持的文件签名，可能是 HTML 错误页。')


async def _download_file(context, page, source, directory):
    """The ordinary click opens a popup whose navigation becomes a download.

    Listeners are attached before the click: a popup can start its download
    before an awaited ``expect_event('page')`` returns, so the popup's
    ``download`` handler is registered synchronously when the page appears.
    The original page is watched too.
    """
    loop = asyncio.get_running_loop()
    arrived = loop.create_future()
    state = {'error': None, 'length': None}
    popups = []
    downloads = []

    def fail(error):
        if state['error'] is None:
            state['error'] = error
        if not arrived.done():
            arrived.set_result(None)

    def on_download(download):
        downloads.append(download)
        if len(downloads) > 1:
            fail(_error('unknown_layout', '一个公告触发了多个下载，已停止。'))
        elif not arrived.done():
            arrived.set_result(download)

    def on_page(new_page):
        popups.append(new_page)
        new_page.on('download', on_download)

    def on_response(response):
        if not _attachment_url(response.url, source):
            return
        if response.status >= 400:
            fail(_denial('', response.status) or _error('network', '公告下载接口返回错误状态。'))
            return
        length = response.headers.get('content-length', '')
        if length.isdigit():
            state['length'] = int(length)

    context.on('page', on_page)
    context.on('response', on_response)
    page.on('download', on_download)
    try:
        await page.get_by_text('下载公告文件', exact=True).click()
        try:
            download = await asyncio.wait_for(asyncio.shield(arrived), timeout=_DOWNLOAD_TIMEOUT)
        except asyncio.TimeoutError:
            for candidate in [*popups, page]:
                await _page_denial(candidate)
            raise _error('network', '公告文件没有在限定时间内开始下载；未自动重试。') from None
        if download is not None and not _attachment_url(download.url, source):
            fail(_error('unknown_layout', '下载目标不是已验证的固定公告文件接口。'))
        if state['length'] is not None and state['length'] > _MAX_BYTES:
            fail(_error('no_attachment', '公告文件超过 50 MiB，已取消下载。'))
        if state['error']:
            raise state['error']
        # The remote suggested filename is never used.
        partial = directory / (source + '-' + uuid4().hex + '.part')
        try:
            await asyncio.wait_for(download.save_as(partial), timeout=_DOWNLOAD_TIMEOUT)
        except asyncio.TimeoutError:
            raise _error('network', '公告文件没有在限定时间内完成下载；未自动重试。') from None
        if state['error']:
            raise state['error']
        if await download.failure() is not None or not partial.is_file():
            raise _error('network', '来源下载被取消或中断。')
        suffix = _file_signature(partial)
        destination = partial.with_suffix(suffix)
        partial.rename(destination)
        return destination
    finally:
        context.remove_listener('page', on_page)
        context.remove_listener('response', on_response)
        page.remove_listener('download', on_download)
        for item in downloads:
            # Cancel is a no-op for finished downloads; delete drops the browser's own copy.
            for step in (item.cancel, item.delete):
                try:
                    await step()
                except Exception:
                    pass
        for popup in popups:
            try:
                await popup.close()
            except Exception:
                pass


async def download_notice(url: str, directory: Path | str) -> DownloadedNotice:
    source, _ = validate_notice_url(url)
    destination = _fresh_directory(directory)
    succeeded = False
    try:
        async with _session(source) as (_, context, page):
            value = await _navigate_response(page, url, 'getNoticeBid')
            notice = _detail_notice(url, value)
            await _page_denial(page)
            if str(value.get('fileFlag')) != '1':
                raise _error('no_attachment', '该公告没有公开的公告文件入口。')
            button = page.get_by_text('下载公告文件', exact=True)
            from playwright.async_api import TimeoutError as BrowserTimeout
            try:
                await button.wait_for(state='visible')
            except BrowserTimeout:
                await _page_denial(page)
                raise _error('unknown_layout', '公告声明有文件，但已验证的下载入口不存在。') from None
            path = await _download_file(context, page, source, destination)
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            result = DownloadedNotice(notice=notice, path=str(path), filename=path.name,
                                      sha256=digest.hexdigest(), method='playwright_public_announcement')
        succeeded = True
        return result
    finally:
        if not succeeded:
            # The caller supplied an empty directory. Remove only our generated files.
            for path in destination.iterdir():
                if path.is_file() and _GENERATED.fullmatch(path.name):
                    path.unlink(missing_ok=True)
