"""Local, non-executing procurement attachment parser.

ZIP members never touch the filesystem. Limits include Office package parts and
all nested archives. Spreadsheet dimensions are advisory; only sheetData and
explicit merge ranges determine values. Evidence retains original cell values,
formats, formula caches, hidden state and merge anchors.
"""
from __future__ import annotations

import hashlib
import io
import math
import posixpath
import re
import stat
import struct
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass, field, fields
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from .contracts import Evidence, ParsedFile, ParseResult, ProjectRow

MAX_TOTAL_BYTES = 100 * 1024 * 1024
MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_FILES = 1000
MAX_DEPTH = 5
_CHUNK = 64 * 1024
_MAX_CELLS = 500_000
_MAX_XML_NODES = 1_000_000
_MAX_MERGED_CELLS = 500_000


class _Invalid(ValueError):
    pass


class _Limit(_Invalid):
    pass


@dataclass
class _Budget:
    inflated: int = 0
    files: int = 0
    expanded_text: int = 0

    def text(self, length: int) -> None:
        # Shared strings and merges can amplify text without inflating ZIP bytes.
        self.expanded_text += length
        if self.expanded_text > MAX_TOTAL_BYTES:
            raise _Limit('工作表展开文本超过安全限制')

    def consume(self, length: int, member_total: int) -> None:
        self.inflated += length
        if member_total > MAX_FILE_BYTES:
            raise _Limit('单个文件实际解压大小超过 30 MiB 限制')
        if self.inflated > MAX_TOTAL_BYTES:
            raise _Limit('累计实际解压大小超过 100 MiB 限制')


def _safe_name(name: str) -> None:
    if not name or name.startswith('/') or '\\' in name or ':' in name:
        raise _Invalid(f'不安全的 ZIP 路径: {name!r}')
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise _Invalid('ZIP 路径含控制字符')
    parts = name.rstrip('/').split('/')
    for part in parts:
        if (part in ('', '.', '..') or part.rstrip(' .') != part
                or re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)):
            raise _Invalid(f'不安全的 ZIP 路径: {name!r}')


def _decode_name(raw: bytes, flags: int) -> str:
    if flags & 0x800:
        return raw.decode('utf-8', errors='strict')
    # Some public downloads use GB18030 in the directory and UTF-8 in the
    # local header. Both independently decoded names must still agree.
    for encoding in ('gb18030', 'cp437'):
        try:
            return raw.decode(encoding, errors='strict')
        except UnicodeError:
            continue
    raise _Invalid('无法解码 ZIP 文件名')


@dataclass
class _Member:
    name: str
    info: zipfile.ZipInfo
    start: int
    end: int


def _check_directory(data: bytes, budget: _Budget) -> None:
    # zipfile builds its entire ZipInfo list before exposing a count. Bound the
    # central directory first, including archives lying about their entry count.
    end = data.rfind(b'PK\x05\x06', max(0, len(data) - 65557))
    if end < 0 or end + 22 > len(data):
        raise _Invalid('ZIP 目录结束记录缺失')
    _, disk, directory_disk, disk_count, count, size, offset, comment = struct.unpack_from('<4s4H2IH', data, end)
    if disk or directory_disk or disk_count != count or end + 22 + comment != len(data):
        raise _Invalid('不支持多卷 ZIP 或 ZIP 结束记录不一致')
    if count == 0xFFFF or size == 0xFFFFFFFF or offset == 0xFFFFFFFF:
        raise _Invalid('此大小限制下不支持 ZIP64 目录')
    if offset + size != end:
        raise _Invalid('ZIP 目录边界不一致或包含前置数据')
    position, actual = offset, 0
    while position < end:
        if position + 46 > end or data[position:position + 4] != b'PK\x01\x02':
            raise _Invalid('ZIP 目录项无效')
        nlen, xlen, clen, start_disk = struct.unpack_from('<4H', data, position + 28)
        if start_disk:
            raise _Invalid('不支持多卷 ZIP 成员')
        position += 46 + nlen + xlen + clen
        actual += 1
        if budget.files + actual > MAX_FILES:
            raise _Limit('累计 ZIP 成员数超过 1000 限制')
    if position != end or actual != count:
        raise _Invalid('ZIP 目录项数量或边界不一致')


class _Archive:
    def __init__(self, data: bytes, budget: _Budget):
        self.data, self.budget = data, budget
        self.members: list[_Member] = []
        _check_directory(data, budget)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            budget.files += len(infos)
            if budget.files > MAX_FILES:
                raise _Limit('累计 ZIP 成员数超过 1000 限制')
            names: set[str] = set()
            spans: list[tuple[int, int]] = []
            for info in infos:
                flags = info.flag_bits
                if flags & 1 or flags & ~(0x800 | 8 | 6):
                    raise _Invalid('不支持加密或特殊标志的 ZIP 成员')
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise _Invalid('不支持的 ZIP 压缩方法（仅支持 stored/deflate）')
                if info.file_size > MAX_FILE_BYTES:
                    raise _Limit('单个 ZIP 成员声明大小超过 30 MiB 限制')
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise _Invalid('拒绝 ZIP 符号链接或特殊文件')
                central_raw = info.orig_filename.encode('utf-8' if flags & 0x800 else 'cp437')
                name = _decode_name(central_raw, flags)
                _safe_name(name)
                if name in names:
                    raise _Invalid(f'重复 ZIP 成员路径: {name}')
                names.add(name)
                offset = info.header_offset
                if offset < 0 or offset + 30 > archive.start_dir:
                    raise _Invalid('ZIP 本地头偏移越界')
                header = struct.unpack_from('<4s5H3I2H', data, offset)
                signature, _, local_flags, method, _, _, crc, compressed, size, nlen, xlen = header
                if signature != b'PK\x03\x04':
                    raise _Invalid('ZIP 本地头签名错误')
                if (local_flags ^ flags) & ~0x800 or method != info.compress_type:
                    raise _Invalid('ZIP 本地头与目录标志或压缩方法不一致')
                start = offset + 30 + nlen + xlen
                end = start + info.compress_size
                if start > archive.start_dir or end > archive.start_dir:
                    raise _Invalid('ZIP 成员数据越界')
                local_raw = data[offset + 30:offset + 30 + nlen]
                local_name = _decode_name(local_raw, local_flags)
                _safe_name(local_name)
                if local_flags != flags or local_raw != central_raw:
                    # The sole repair is the observed GB18030 central / UTF-8
                    # local combination. Do not accept other header mismatches.
                    if flags & 0x800 or not local_flags & 0x800 or central_raw.decode('gb18030') != local_name:
                        raise _Invalid('ZIP 本地头与目录文件名编码不一致')
                if local_name != name:
                    raise _Invalid('ZIP 本地头与目录文件名不一致')
                # ZIP64 is unnecessary under these limits; never guess its sizes.
                if compressed == 0xFFFFFFFF or size == 0xFFFFFFFF:
                    raise _Invalid('此大小限制下不支持 ZIP64 本地头')
                if flags & 8:
                    if crc not in (0, info.CRC) or compressed not in (0, info.compress_size) or size not in (0, info.file_size):
                        raise _Invalid('ZIP 本地头大小或 CRC 与目录不一致')
                    descriptor = end
                    if data[descriptor:descriptor + 4] == b'PK\x07\x08':
                        descriptor += 4
                    if descriptor + 12 > archive.start_dir:
                        raise _Invalid('ZIP 数据描述符缺失')
                    if struct.unpack_from('<III', data, descriptor) != (info.CRC, info.compress_size, info.file_size):
                        raise _Invalid('ZIP 数据描述符大小或 CRC 错误')
                    span_end = descriptor + 12
                else:
                    if (crc, compressed, size) != (info.CRC, info.compress_size, info.file_size):
                        raise _Invalid('ZIP 本地头大小或 CRC 与目录不一致')
                    span_end = end
                if name.endswith('/') and (info.file_size or info.compress_size not in (0, 2)):
                    raise _Invalid('ZIP 目录包含文件数据')
                spans.append((offset, span_end))
                self.members.append(_Member(name, info, start, end))
            spans.sort()
            if spans and spans[0][0] != 0:
                raise _Invalid('拒绝带前置数据的 ZIP')
            if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
                raise _Invalid('ZIP 成员数据重叠')

    def read(self, member: _Member) -> bytes:
        info = member.info
        out = bytearray()
        crc = 0

        def accept(chunk: bytes) -> None:
            nonlocal crc
            self.budget.consume(len(chunk), len(out) + len(chunk))
            crc = zlib.crc32(chunk, crc)
            out.extend(chunk)

        if info.compress_type == zipfile.ZIP_STORED:
            for start in range(member.start, member.end, _CHUNK):
                accept(self.data[start:min(start + _CHUNK, member.end)])
        else:
            inflater = zlib.decompressobj(-15)
            for start in range(member.start, member.end, _CHUNK):
                pending = self.data[start:min(start + _CHUNK, member.end)]
                while pending:
                    allowance = min(_CHUNK, MAX_FILE_BYTES - len(out) + 1,
                                    MAX_TOTAL_BYTES - self.budget.inflated + 1)
                    chunk = inflater.decompress(pending, max(1, allowance))
                    accept(chunk)
                    pending = inflater.unconsumed_tail
                    if inflater.unused_data:
                        raise _Invalid('ZIP 压缩流含尾随数据')
            if not inflater.eof:
                raise _Invalid('ZIP 压缩流不完整')
        if len(out) != info.file_size:
            raise _Invalid('ZIP 实际解压大小与声明不一致')
        if crc != info.CRC:
            raise _Invalid('ZIP CRC 校验失败')
        return bytes(out)


class _XMLBuilder(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0

    def doctype(self, name, pubid, system):
        raise _Invalid('XML 禁止 DTD 和实体声明')

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 128 or self.nodes > _MAX_XML_NODES:
            raise _Limit('XML 结构超过安全限制')
        return super().start(tag, attrs)

    def end(self, tag):
        self.depth -= 1
        return super().end(tag)


def _xml(data: bytes) -> ET.Element:
    return ET.fromstring(data, parser=ET.XMLParser(target=_XMLBuilder()))


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit('}', 1)[-1]


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if _tag(child) == name]


def _child(element: ET.Element, name: str) -> ET.Element | None:
    return next((child for child in element if _tag(child) == name), None)


def _text(element: ET.Element | None) -> str:
    if element is None:
        return ''
    text = []
    pending = [element]
    while pending:
        node = pending.pop()
        if _tag(node) in ('rPh', 'phoneticPr'):
            continue
        if _tag(node) == 't':
            text.append(node.text or '')
        pending.extend(reversed(list(node)))
    return ''.join(text)


def _normal(value: str) -> str:
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).casefold()


def _column(number: int) -> str:
    output = ''
    while number:
        number, rem = divmod(number - 1, 26)
        output = chr(65 + rem) + output
    return output


def _coordinate(value: str) -> tuple[int, int]:
    match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', value)
    if not match:
        raise _Invalid(f'无效单元格坐标: {value!r}')
    col = 0
    for letter in match[1]:
        col = col * 26 + ord(letter) - 64
    row = int(match[2])
    if col > 16384 or row > 1048576:
        raise _Invalid('单元格坐标超出 XLSX 范围')
    return row, col


_BUILTIN_FORMATS = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 49: '@',
}


def _formats(parts: dict[str, bytes]) -> list[str]:
    if 'xl/styles.xml' not in parts:
        return ['General']
    root = _xml(parts['xl/styles.xml'])
    formats = dict(_BUILTIN_FORMATS)
    custom = _child(root, 'numFmts')
    if custom is not None:
        for item in custom:
            formats[int(item.attrib['numFmtId'])] = item.attrib['formatCode']
    xfs = _child(root, 'cellXfs')
    if xfs is None:
        return ['General']
    return [formats.get(int(x.attrib.get('numFmtId', '0')), f"builtin:{x.attrib.get('numFmtId')}") for x in xfs]


def _number(raw: str) -> Decimal:
    if len(raw) > 256 or not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,4})?', raw):
        raise _Invalid('无效或超长的数值单元格')
    value = Decimal(raw)
    if not value.is_finite() or abs(value.adjusted()) > 308:
        raise _Invalid('数值单元格超出支持范围')
    return value


def _display_number(value: Decimal, code: str) -> tuple[str, str]:
    plain = format(value, 'f')
    if '.' in plain:
        plain = plain.rstrip('0').rstrip('.')
    if code in ('General', '@'):
        return plain, ''
    # Only formats we can reproduce faithfully are interpreted. Unsupported
    # Excel formats remain explicit in evidence instead of silently guessed.
    if len(code) <= 128 and re.fullmatch(r'(?:#,##)?0+(?:\.[0#]+)?%?', code):
        percent = code.endswith('%')
        body = code.rstrip('%')
        integer, _, fraction = body.partition('.')
        with localcontext() as context:
            context.prec = 650
            scaled = value * (100 if percent else 1)
            rounded = scaled.quantize(Decimal(1).scaleb(-len(fraction)), rounding=ROUND_HALF_UP)
            text = format(abs(rounded), f'.{len(fraction)}f')
        whole, dot, tail = text.partition('.')
        whole = whole.zfill(integer.count('0'))
        if ',' in integer:
            whole = format(int(whole), ',')
        optional = len(fraction) - len(fraction.rstrip('#'))
        if optional:
            trim = min(optional, len(tail) - len(tail.rstrip('0')))
            tail = tail[:len(tail) - trim] if trim else tail
        text = ('-' if rounded < 0 else '') + whole + ('.' + tail if tail else '')
        return text + ('%' if percent else ''), ''
    return plain, f'未解释的数值格式 {code!r}；保留原始数值和格式'


@dataclass
class _Cell:
    coordinate: str
    text: str
    raw: dict[str, Any]
    warning: str = ''


def _cell(element: ET.Element, shared: list[str], formats: list[str]) -> _Cell:
    coordinate = element.attrib['r']
    kind = element.attrib.get('t', 'n')
    style = int(element.attrib.get('s', '0'))
    if style < 0 or style >= len(formats):
        raise _Invalid(f'{coordinate} 引用了不存在的样式')
    code = formats[style]
    v = _child(element, 'v')
    value = v.text if v is not None and v.text is not None else ''
    formula = _child(element, 'f')
    raw: dict[str, Any] = {'type': kind, 'value': value, 'number_format': code}
    warning = ''
    if formula is not None:
        raw.update(formula=formula.text or '', formula_attributes=dict(formula.attrib),
                   cached=v is not None and v.text is not None, formula_evaluated=False)
        if not raw['cached']:
            raw['value'] = None
            raw['text'] = ''
            return _Cell(coordinate, '', raw, '公式没有缓存值，结果未知（未执行公式）')
    if kind == 's':
        index = int(value)
        if index < 0 or index >= len(shared):
            raise _Invalid(f'{coordinate} 引用了不存在的共享字符串')
        text = shared[index]
        raw['shared_string_index'] = index
        raw['value'] = text
    elif kind == 'inlineStr':
        text = _text(_child(element, 'is'))
        raw['value'] = text
    elif kind in ('str', 'd'):
        text = value
    elif kind == 'b':
        if value not in ('0', '1'):
            raise _Invalid(f'{coordinate} 布尔值无效')
        raw['value'] = value == '1'
        text = 'TRUE' if value == '1' else 'FALSE'
    elif kind == 'e':
        text = ''
        warning = f'源单元格错误 {value}，值未知'
    elif kind == 'n' and value:
        number = _number(value)
        numeric = int(number) if number == number.to_integral_value() else float(number)
        if isinstance(numeric, float) and not math.isfinite(numeric):
            raise _Invalid(f'{coordinate} 数值非有限')
        raw.update(value=numeric, numeric=numeric, numeric_text=value)
        text, warning = _display_number(number, code)
    elif kind == 'n':
        text = ''
        raw['value'] = None
    else:
        raise _Invalid(f'{coordinate} 不支持的单元格类型 {kind!r}')
    raw['text'] = text
    return _Cell(coordinate, text, raw, warning)


_ALIASES = {
    'batch': ('批次编号', '批次号', '采购批次编号', '招标编号'),
    'section': ('分标编号', '分标号', '标段编号', '标段号', '标段'),
    'section_name': ('分标名称', '标段名称'),
    'package': ('包号', '包编号', '标包编号', '包件编号', '分包'),
    'subpackage': ('子包号', '子包编号', '分包编号'),
    'package_name': ('包名称', '标包名称', '包件名称', '分包名称'),
    'project_name': ('项目名称', '工程名称', '采购项目名称'),
    'buyer': ('项目单位', '采购人', '采购单位', '需求单位', '建设单位'),
    'scope': ('采购内容', '采购范围', '服务内容', '工作内容', '项目概况', '招标范围', '物料(服务)名称'),
    'qualifications': ('响应供应商资质要求', '投标人资质要求', '供应商资质要求', '资质要求', '资格要求', '专用资格要求', '专用资格要求/业绩资质要求'),
    'personnel': ('项目负责人要求', '项目经理要求', '人员要求'),
    'performance': ('供应商业绩要求', '投标人业绩要求', '业绩要求'),
    'location': ('建设地点', '实施地点', '项目地点', '服务地点', '交货地点'),
    'deadline': ('投标截止时间', '响应截止时间', '应答截止时间', '投标截止日期', '响应截止日期'),
    'ceiling': ('最高限价', '最高投标限价', '控制价'),
    'budget': ('采购估算金额', '估算金额', '预算金额', '采购预算'),
    'pricing': ('报价方式', '计价方式'),
    'request_id': ('采购申请标识', '采购申请号', '采购申请编号', '网省采购申请号', '需求编号'),
    'technical_id': ('技术规范书id', '技术规范书编号', '技术规范编码', '技术规范书编码'),
    'consortium': ('是否接受联合体应答', '是否接受联合体投标', '是否接受联合体', '联合体要求'),
}
_ALIAS_MAP = {_normal(label): key for key, labels in _ALIASES.items() for label in labels}


def _label_key(text: str) -> str | None:
    normalized = _normal(text)
    if normalized in _ALIAS_MAP:
        return _ALIAS_MAP[normalized]
    base = re.sub(r'\([^)]*\)', '', normalized)
    return _ALIAS_MAP.get(base)


def _schema(row: dict[int, _Cell]) -> tuple[str, dict[str, int]] | None:
    mapping: dict[str, int] = {}
    labels = {_normal(cell.text) for cell in row.values()}
    goods = '网省采购申请号' in labels and ('物资名称' in labels or '物料编码' in labels)
    for col, cell in row.items():
        key = _label_key(cell.text)
        if key:
            if goods and key == 'package_name':
                key = 'package'
            if key not in mapping or (goods and _normal(cell.text) in ('需求单位', '网省采购申请号')):
                mapping[key] = col
    required = {'section', 'package', 'project_name'}
    if required <= mapping.keys() and any(k in mapping for k in ('scope', 'qualifications', 'request_id', 'ceiling')):
        return ('goods' if goods else 'demand'), mapping
    return None


def _ceiling_kind(value: str, pricing: str, header: str) -> str:
    value = _normal(value)
    if value in ('', '/', '-', '无', '不适用'):
        return 'unknown'
    if '%' in value:
        return 'percent'
    if '万元' in value:
        return 'amount_wan'
    if re.fullmatch(r'[+-]?[\d,]+(?:\.\d+)?元', value):
        return 'amount_yuan'
    if re.fullmatch(r'[+-]?\d+(?:\.\d+)?', value.replace(',', '')):
        if re.search(r'\((?:人民币)?元\)', _normal(header)):
            return 'amount_yuan'
        if ('折扣' in pricing or '费率' in pricing or '百分比' in pricing
                or ('万元' not in header and any(k in header for k in ('折扣', '费率', '%')))):
            return 'percent'
        if '万元' in header and (not any(k in header for k in ('折扣', '费率', '%')) or any(k in pricing for k in ('总价', '单价', '金额'))):
            return 'amount_wan'
    return 'unknown'


@dataclass
class _Candidate:
    row: ProjectRow
    view: str
    file: ParsedFile


@dataclass
class _Context:
    result: ParseResult = field(default_factory=ParseResult)
    budget: _Budget = field(default_factory=_Budget)
    candidates: list[_Candidate] = field(default_factory=list)
    warning_set: set[str] = field(default_factory=set)

    def warn(self, text: str) -> None:
        if text not in self.warning_set:
            self.warning_set.add(text)
            self.result.warnings.append(text)


def _part_target(base: str, target: str) -> str:
    target = unquote(target)
    if '\\' in target or ':' in target or target.startswith('//') or '?' in target or '#' in target:
        raise _Invalid('不安全的 Office 内部关系路径')
    resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(base), target))
    _safe_name(resolved)
    return resolved


def _sheet(parts: dict[str, bytes], part: str, name: str, state: str, shared: list[str],
           formats: list[str], parsed: ParsedFile, context: _Context) -> tuple[dict[str, Any], list[_Candidate]]:
    root = _xml(parts[part])
    if _tag(root) != 'worksheet':
        raise _Invalid('工作表 XML 根节点无效')
    sheet_data = _child(root, 'sheetData')
    grid: dict[int, dict[int, _Cell]] = {}
    hidden: dict[int, bool] = {}
    count = 0
    if sheet_data is not None:
        previous = 0
        for element in _children(sheet_data, 'row'):
            rownum = int(element.attrib.get('r', str(previous + 1)))
            if rownum in grid or not 1 <= rownum <= 1048576:
                raise _Invalid('工作表行号重复或越界')
            previous = rownum
            row: dict[int, _Cell] = {}
            hidden[rownum] = element.attrib.get('hidden') in ('1', 'true')
            for cell_element in _children(element, 'c'):
                r, c = _coordinate(cell_element.attrib['r'])
                if r != rownum or c in row:
                    raise _Invalid('单元格坐标与行不一致或重复')
                row[c] = _cell(cell_element, shared, formats)
                context.budget.text(len(row[c].text))
                count += 1
                if count > _MAX_CELLS:
                    raise _Limit('工作表单元格数超过安全限制')
            grid[rownum] = row
    merge_root = _child(root, 'mergeCells')
    merge_list = [element.attrib['ref'] for element in _children(merge_root, 'mergeCell')] if merge_root is not None else []
    return _table(grid, hidden, merge_list, part, name, state, parsed, context)


def _table(grid: dict[int, dict[int, _Cell]], hidden: dict[int, bool], merge_list: list[str],
           part: str, name: str, state: str, parsed: ParsedFile,
           context: _Context) -> tuple[dict[str, Any], list[_Candidate]]:
    merges: dict[tuple[int, int], tuple[tuple[int, int], str]] = {}
    for reference in merge_list:
        endpoints = reference.split(':')
        if len(endpoints) != 2:
            raise _Invalid('无效合并单元格范围')
        r1, c1 = _coordinate(endpoints[0])
        r2, c2 = _coordinate(endpoints[1])
        if r1 > r2 or c1 > c2:
            raise _Invalid('倒序合并单元格范围')
        if len(merges) + (r2 - r1 + 1) * (c2 - c1 + 1) > _MAX_MERGED_CELLS:
            raise _Limit('合并单元格范围超过安全限制')
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if (r, c) in merges:
                    raise _Invalid('合并单元格范围重叠')
                merges[r, c] = ((r1, c1), reference)
                existing = grid.get(r, {}).get(c)
                if (r, c) != (r1, c1) and existing and existing.text:
                    raise _Invalid('合并区域非锚点包含冲突值')

    def resolve(r: int, c: int) -> _Cell | None:
        anchor, _ = merges.get((r, c), ((r, c), ''))
        return grid.get(anchor[0], {}).get(anchor[1])

    summary: dict[str, Any] = {'name': name, 'part': part, 'state': state, 'status': 'unsupported',
                               'rows': 0, 'source_rows': len(grid), 'merge_count': len(merge_list),
                               'merges': merge_list, 'hidden_rows': [r for r in hidden if hidden[r]]}
    schema = None
    header_row = 0
    for rownum in sorted(grid)[:50]:
        schema = _schema(grid[rownum])
        if schema:
            header_row = rownum
            break
    if schema is None:
        summary['error'] = '未识别工作表表头；未按固定列位置猜测'
        context.warn(f'{parsed.name} / {name}: {summary["error"]}')
        return summary, []
    view, mapping = schema
    summary.update(schema=view, header_row=header_row, status='parsed',
                   missing_fields=[key for key in _ALIASES if key not in mapping])
    headers = {_column(c): cell.text for c, cell in grid[header_row].items()}
    rows: list[_Candidate] = []
    for rownum in sorted(grid):
        if rownum <= header_row:
            continue
        original = grid[rownum]
        if not any(cell.text or cell.warning for cell in original.values()):
            continue
        if _schema(original):
            continue
        resolved = {key: resolve(rownum, col) for key, col in mapping.items()}
        values = {key: cell.text.strip() if cell else '' for key, cell in resolved.items()}
        row_warnings: list[str] = []
        if not any(values.get(k) for k in ('section', 'package', 'project_name', 'request_id')):
            summary['status'] = 'partial'
            context.warn(f'{parsed.name} / {name} / 行 {rownum}: 非空行无法识别为项目，未静默丢弃')
            continue
        if not values.get('section') or not values.get('package'):
            row_warnings.append('分标或包号缺失；不进行隐式向下填充或名称关联')
        if not values.get('request_id'):
            row_warnings.append('采购申请标识缺失；不能可靠合并不同附件视图')
        raw_cells = {cell.coordinate: dict(cell.raw) for cell in original.values()}
        raw_merges: dict[str, dict[str, str]] = {}
        for col in set(original) | set(mapping.values()):
            cell = resolve(rownum, col)
            if cell:
                if cell.coordinate != f'{_column(col)}{rownum}':
                    context.budget.text(len(cell.text))
                raw_cells[cell.coordinate] = dict(cell.raw)
                if cell.warning:
                    row_warnings.append(f'{cell.coordinate}: {cell.warning}')
                if (rownum, col) in merges:
                    _, merge = merges[rownum, col]
                    raw_merges[f'{_column(col)}{rownum}'] = {'range': merge, 'anchor': cell.coordinate}
        context.budget.text(sum(len(label) for label in headers.values()) + len(parsed.name) + len(name))
        evidence = Evidence(
            file=parsed.name, sheet=name, row=rownum,
            cells={key: cell.coordinate for key, cell in resolved.items() if cell},
            raw={'view': view, 'header_row': header_row, 'headers': headers,
                 'hidden_row': hidden[rownum], 'hidden_sheet': state != 'visible',
                 'cells': raw_cells, 'merges': raw_merges,
                 'extra': {f'{_column(c)}: {headers.get(_column(c), "") }': cell.text
                           for c, cell in original.items() if c not in mapping.values()}},
        )
        scalar = {f.name: '' for f in fields(ProjectRow) if f.name not in ('evidence', 'warnings')}
        scalar.update(values)
        ceiling_header = headers.get(_column(mapping.get('ceiling', 0)), '')
        scalar['ceiling_kind'] = _ceiling_kind(scalar['ceiling'], scalar['pricing'], ceiling_header)
        if scalar['ceiling_kind'] == 'amount_yuan':
            source = resolved.get('ceiling')
            if source:
                raw_value = source.raw.get('numeric_text', source.text.replace(',', '').removesuffix('元').strip())
                try:
                    with localcontext() as precision:
                        precision.prec = 650
                        normalized, _ = _display_number(_number(raw_value) / 10000, 'General')
                    evidence.raw['normalized_amount_wan'] = normalized
                    evidence.raw['ceiling_conversion'] = {'source_cell': source.coordinate, 'source_unit': '元',
                                                          'target_unit': '万元', 'divisor': 10000}
                except _Invalid:
                    pass
        if scalar['ceiling'] not in ('', '/', '-', '无', '不适用') and scalar['ceiling_kind'] == 'unknown':
            row_warnings.append('最高限价单位不明确；未将金额与折扣率混为一谈')
        if row_warnings:
            summary['status'] = 'partial'
            for warning in dict.fromkeys(row_warnings):
                context.warn(f'{parsed.name} / {name} / 行 {rownum}: {warning}')
        project = ProjectRow(**scalar, evidence=[evidence], warnings=list(dict.fromkeys(row_warnings)))
        rows.append(_Candidate(project, view, parsed))
    summary['rows'] = len(rows)
    if not rows:
        summary.update(status='partial', error='已识别表头，但没有可解析的项目数据行')
        context.warn(f'{parsed.name} / {name}: {summary["error"]}')
    if view == 'goods':
        context.warn(f'{parsed.name} / {name}: 货物清单仅为明细视图，不代表完整资质要求')
    return summary, rows


def _xlsx(parts: dict[str, bytes], parsed: ParsedFile, context: _Context) -> list[_Candidate]:
    root = _xml(parts['xl/workbook.xml'])
    if _tag(root) != 'workbook':
        raise _Invalid('工作簿 XML 根节点无效')
    shared = []
    if 'xl/sharedStrings.xml' in parts:
        shared = [_text(si) for si in _children(_xml(parts['xl/sharedStrings.xml']), 'si')]
    formats = _formats(parts)
    relation_part = 'xl/_rels/workbook.xml.rels'
    if relation_part not in parts:
        raise _Invalid('缺少工作簿关系文件')
    relationships = {}
    for rel in _xml(parts[relation_part]):
        identity = rel.attrib.get('Id')
        if not identity or identity in relationships:
            raise _Invalid('工作簿关系标识缺失或重复')
        relationships[identity] = rel.attrib
    sheets = _child(root, 'sheets')
    if sheets is None or not len(sheets):
        raise _Invalid('工作簿没有工作表')
    rows: list[_Candidate] = []
    seen_parts: set[str] = set()
    for sheet in sheets:
        name = sheet.attrib.get('name', '')
        rid = next((v for k, v in sheet.attrib.items() if k.endswith('}id')), '')
        relationship = relationships.get(rid)
        try:
            if not relationship or relationship.get('TargetMode') == 'External':
                raise _Invalid('工作表关系缺失或指向外部资源（未访问）')
            if not relationship.get('Type', '').endswith('/worksheet'):
                raise _Invalid('不支持的工作表类型')
            target = _part_target('xl/workbook.xml', relationship['Target'])
            if target not in parts or target in seen_parts:
                raise _Invalid('工作表 XML 缺失或被重复引用')
            seen_parts.add(target)
            summary, candidates = _sheet(parts, target, name, sheet.attrib.get('state', 'visible'), shared, formats, parsed, context)
            parsed.sheets.append(summary)
            rows.extend(candidates)
        except (_Invalid, ET.ParseError, KeyError, ValueError, OverflowError) as exc:
            if isinstance(exc, _Limit):
                raise
            parsed.sheets.append({'name': name, 'status': 'error', 'rows': 0, 'error': str(exc)})
            context.warn(f'{parsed.name} / {name}: {exc}')
    for part in parts:
        if part.startswith('xl/worksheets/') and part.endswith('.xml') and part not in seen_parts:
            context.warn(f'{parsed.name}: 未被工作簿引用的工作表 {part}，未解析')
            parsed.sheets.append({'name': part, 'status': 'unsupported', 'rows': 0, 'error': '工作表未被工作簿引用'})
    parsed.status = 'parsed' if all(s['status'] == 'parsed' for s in parsed.sheets) else 'partial'
    return rows


class _XLSLog:
    """Keep reader diagnostics bounded and off stdout."""
    def __init__(self):
        self.text = ''

    def write(self, text: str) -> int:
        self.text += text[:max(0, 4096 - len(self.text))]
        return len(text)


_OLE_SIGNATURE = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'


def _xls_stream(data: bytes, context: _Context, log: _XLSLog) -> tuple[bytes, bool]:
    from xlrd import compdoc

    if not data.startswith(_OLE_SIGNATURE):
        return data, False
    if len(data) < 512 or len(data) % 512 or struct.unpack_from('<HH', data, 30) != (9, 6):
        raise _Invalid('不支持或损坏的 XLS OLE 扇区结构（仅支持 512/64 字节扇区）')

    class BoundedCompound(compdoc.CompDoc):
        def _get_stream(self, mem, base, sat, sec_size, start_sid, size=None, name='', seen_id=None):
            # xlrd checks normal FAT chains, but not cycles in mini-FAT chains.
            # Validate every chain before entering its reader, without relaxing
            # its corruption checks or executing any embedded stream.
            visited = set()
            sid = start_sid
            while sid >= 0:
                if sid in visited or sid >= len(sat) or base + (sid + 1) * sec_size > len(mem):
                    raise _Invalid('XLS OLE 扇区链循环或越界')
                visited.add(sid)
                if len(visited) * sec_size > MAX_FILE_BYTES:
                    raise _Limit('XLS OLE 流超过单文件限制')
                sid = sat[sid]
            if sid != compdoc.EOCSID:
                raise _Invalid('XLS OLE 扇区链终止符无效')
            if size is not None and (size < 0 or size > MAX_FILE_BYTES or (size + sec_size - 1) // sec_size != len(visited)):
                raise _Invalid('XLS OLE 流声明大小与实际扇区链不一致')
            value = super()._get_stream(mem, base, sat, sec_size, start_sid, size, name, seen_id)
            context.budget.consume(len(value), len(value))
            if name == 'directory':
                if len(value) % 128:
                    raise _Invalid('XLS OLE 目录项长度无效')
                count = len(value) // 128
                context.budget.files += count
                if context.budget.files > MAX_FILES:
                    raise _Limit('XLS OLE 目录和 ZIP 成员累计超过 1000 限制')
                for position in range(0, len(value), 128):
                    entry_type = value[position + 66]
                    name_length = struct.unpack_from('<H', value, position + 64)[0]
                    if name_length > 64 or name_length % 2:
                        raise _Invalid('XLS OLE 目录名称长度无效')
                    if entry_type in (2, 5) and struct.unpack_from('<Q', value, position + 120)[0] > MAX_FILE_BYTES:
                        raise _Limit('XLS OLE 声明流大小超过单文件限制')
                # Bound the directory tree before xlrd recursively traverses it.
                pending = [(struct.unpack_from('<i', value, 76)[0], 1)]
                seen = set()
                while pending:
                    node, depth = pending.pop()
                    if node == -1:
                        continue
                    if not 0 < node < count or node in seen or depth > 128:
                        raise _Invalid('XLS OLE 目录树循环、过深或越界')
                    seen.add(node)
                    left, right, child = struct.unpack_from('<iii', value, node * 128 + 68)
                    pending.extend([(left, depth + 1), (right, depth + 1)])
                    if value[node * 128 + 66] == 1:
                        pending.append((child, depth + 1))
            return value

    document = BoundedCompound(data, logfile=log, ignore_workbook_corruption=False)
    active = any(node.name.lower() in ('vba', '_vba_project', '_vba_project_cur', 'objectpool')
                 or node.name.lower().startswith('mbd') for node in document.dirlist)
    stream = document.get_named_stream('Workbook')
    if stream is None:
        stream = document.get_named_stream('Book')
    if not stream:
        raise _Invalid('OLE 文件缺少 XLS Workbook/Book 流')
    return stream, active


def _biff_records(data: bytes, start: int):
    count = 0
    while start + 4 <= len(data):
        offset = start
        code, length = struct.unpack_from('<HH', data, start)
        start += 4
        if length > 8224 or start + length > len(data):
            raise _Invalid('XLS BIFF 记录长度越界或不完整')
        count += 1
        if count > _MAX_CELLS:
            raise _Limit('XLS BIFF 记录数量超过限制')
        value = data[start:start + length]
        start += length
        yield offset, code, value
        if code == 0x000A:
            return
    raise _Invalid('XLS BIFF 子流缺少 EOF')


def _biff_index(data: bytes) -> tuple[list[tuple[int, str, int]], dict[int, dict], bool]:
    """Preflight resource bounds and formula cache provenance; xlrd reads values."""
    if len(data) < 8 or struct.unpack_from('<H', data)[0] != 0x0809:
        raise _Invalid('不是受支持的原生 XLS BIFF5/8 工作簿')
    version, stream_type = struct.unpack_from('<HH', data, 4)
    if version not in (0x0500, 0x0600) or stream_type != 0x0005:
        raise _Invalid('仅支持 XLS BIFF5/8 工作簿，其他版本未解析')
    sheets, metadata = [], {}
    external = False
    global_end = 0
    for offset, code, value in _biff_records(data, 0):
        global_end = offset + 4 + len(value)
        if code == 0x002F:
            raise _Invalid('加密 XLS 不支持（FILEPASS）')
        if code == 0x0085:
            if len(value) < 8:
                raise _Invalid('XLS BOUNDSHEET 记录不完整')
            sheet_offset, _, kind = struct.unpack_from('<IBB', value)
            length = value[6]
            if version == 0x0600:
                wide = value[7] & 1
                name = value[8:8 + length * (2 if wide else 1)].decode('utf-16-le' if wide else 'latin1')
            else:
                name = f'BIFF5 sheet {len(sheets) + 1}'
            sheets.append((sheet_offset, name, kind))
            if len(sheets) > MAX_FILES:
                raise _Limit('XLS 工作表数量超过限制')
        if code == 0x00FC and (len(value) < 8 or struct.unpack_from('<I', value, 4)[0] > _MAX_CELLS):
            raise _Limit('XLS 共享字符串数量超过限制')
        if code == 0x01AE and (len(value) < 4 or value[2:4] not in (b'\x01\x04', b'\x01\x3a')):
            external = True
    capacity = 0
    offsets = set()
    for offset, name, kind in sheets:
        if offset < global_end or offset in offsets or offset + 8 > len(data):
            raise _Invalid('XLS 工作表偏移重复或越界')
        offsets.add(offset)
        if kind != 0:
            continue  # Macro/chart sheets are reported, never executed.
        if struct.unpack_from('<H', data, offset)[0] != 0x0809:
            raise _Invalid('XLS 工作表 BOF 缺失')
        extents, formulas, occupied = {}, {}, set()
        pending_string = None
        merge_area = 0
        maxrow = -1
        for record_offset, code, value in _biff_records(data, offset):
            if pending_string is not None:
                if code in (0x0221, 0x04BC, 0x0236, 0x0036, 0x0037):
                    continue
                if code != 0x0207:
                    raise _Invalid(f'XLS 公式 {pending_string} 缺少 STRING 缓存，结果未知（未执行）')
                pending_string = None
            if code == 0x002F:
                raise _Invalid('加密 XLS 不支持（FILEPASS）')
            if record_offset != offset and code in (0x0009, 0x0209, 0x0409, 0x0809):
                raise _Invalid('XLS 工作表包含未支持的嵌套 BIFF 子流')
            if code in (0x0203, 0x0204, 0x00FD, 0x027E, 0x0205, 0x0201,
                        0x0006, 0x0206, 0x0406, 0x00D6, 0x00BD, 0x00BE):
                if len(value) < 6:
                    raise _Invalid('XLS 单元格记录不完整')
                r, c = struct.unpack_from('<HH', value)
                last = struct.unpack_from('<H', value, len(value) - 2)[0] if code in (0x00BD, 0x00BE) else c
                if not c <= last < 256:
                    raise _Invalid('XLS 单元格列号越界')
                if code in (0x00BD, 0x00BE) and len(value) != 6 + (last - c + 1) * (6 if code == 0x00BD else 2):
                    raise _Invalid('XLS 多单元格记录长度不一致')
                for column in range(c, last + 1):
                    if (r, column) in occupied:
                        raise _Invalid('XLS 单元格记录重复')
                    occupied.add((r, column))
                extents[r] = max(extents.get(r, 0), last + 1)
                maxrow = max(maxrow, r)
                if len(occupied) > _MAX_CELLS:
                    raise _Limit('XLS 单元格数超过限制')
                if code in (0x0006, 0x0206, 0x0406):
                    if len(value) < 22 or 22 + struct.unpack_from('<H', value, 20)[0] > len(value):
                        raise _Invalid('XLS 公式记录或缓存不完整，结果未知')
                    cache = value[6:14]
                    special = cache[6:8] == b'\xff\xff'
                    cache_kind = {0: 'string', 1: 'boolean', 2: 'error', 3: 'empty_string'}.get(cache[0], 'invalid') if special else 'number'
                    if cache_kind == 'invalid':
                        raise _Invalid('XLS 公式缓存类型无效')
                    coordinate = f'{_column(c + 1)}{r + 1}'
                    if cache_kind == 'string':
                        pending_string = coordinate
                    formulas[r, c] = {'formula_tokens_hex': value[22:].hex(), 'formula_record_offset': record_offset,
                                      'formula_evaluated': False, 'cached': True, 'cached_verified': False,
                                      'cache_kind': cache_kind, 'cache_bytes_hex': cache.hex()}
            if code == 0x00E5:
                if len(value) < 2 or len(value) != 2 + struct.unpack_from('<H', value)[0] * 8:
                    raise _Invalid('XLS 合并范围记录损坏')
                for p in range(2, len(value), 8):
                    r1, r2, c1, c2 = struct.unpack_from('<HHHH', value, p)
                    if r1 > r2 or c1 > c2 or c2 >= 256:
                        raise _Invalid('XLS 合并范围无效')
                    merge_area += (r2 - r1 + 1) * (c2 - c1 + 1)
                    maxrow = max(maxrow, r2)
                    if merge_area > _MAX_MERGED_CELLS:
                        raise _Limit('XLS 合并展开超过限制')
        capacity += sum(extents.values()) + maxrow + 1
        if capacity > _MAX_CELLS:
            raise _Limit('XLS 工作表稀疏行/单元格展开超过限制')
        metadata[offset] = formulas
    return sheets, metadata, external


def _xls(data: bytes, parsed: ParsedFile, context: _Context) -> list[_Candidate]:
    import xlrd
    from xlrd.compdoc import CompDocError

    book = None
    log = _XLSLog()
    try:
        stream, active = _xls_stream(data, context, log)
        sheets, metadata, external = _biff_index(stream)
        if not sheets:
            raise _Invalid('XLS 没有工作表')
        book = xlrd.open_workbook(file_contents=stream, formatting_info=True, on_demand=True,
                                  ragged_rows=True, use_mmap=False, logfile=log,
                                  ignore_workbook_corruption=False)
        formats = [book.format_map[xf.format_key].format_str for xf in book.xf_list]
        rows = []
        sheet_index = 0
        for offset, name, kind in sheets:
            if kind != 0:
                parsed.sheets.append({'name': name, 'status': 'unsupported', 'rows': 0, 'error': '宏表、图表或 VBA 模块未执行/解析'})
                context.warn(f'{parsed.name} / {name}: 非数据工作表未执行/解析')
                continue
            sheet = book.sheet_by_index(sheet_index)
            sheet_index += 1
            grid, hidden = {}, {}
            for r in range(sheet.nrows):
                row = {}
                hidden[r + 1] = bool(sheet.rowinfo_map.get(r) and sheet.rowinfo_map[r].hidden)
                for c in range(sheet.row_len(r)):
                    source = sheet.cell(r, c)
                    formula = metadata[offset].get((r, c))
                    if source.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK) and not formula:
                        continue
                    coordinate = f'{_column(c + 1)}{r + 1}'
                    kind_name = {xlrd.XL_CELL_TEXT: 'str', xlrd.XL_CELL_NUMBER: 'n', xlrd.XL_CELL_DATE: 'n',
                                 xlrd.XL_CELL_BOOLEAN: 'b', xlrd.XL_CELL_ERROR: 'e'}.get(source.ctype, 'str')
                    element = ET.Element('c', r=coordinate, t=kind_name, s=str(source.xf_index))
                    value = xlrd.error_text_from_code.get(source.value, f'BIFF error {source.value}') if kind_name == 'e' else str(source.value)
                    ET.SubElement(element, 'v').text = value
                    cell = _cell(element, [], formats)
                    cell.raw.update(source_format=f'BIFF{book.biff_version // 10}', xf_index=source.xf_index)
                    if source.ctype in (xlrd.XL_CELL_NUMBER, xlrd.XL_CELL_DATE):
                        cell.raw['biff_numeric_bytes_hex'] = struct.pack('<d', source.value).hex()
                    if source.ctype == xlrd.XL_CELL_DATE:
                        cell.raw['date_system'] = '1904' if book.datemode else '1900'
                    if formula:
                        cell.raw.update(formula)
                        cell.warning = '; '.join(filter(None, (cell.warning, 'XLS 公式仅保留缓存值，未执行或验证，缓存可能过期')))
                    context.budget.text(len(cell.text))
                    row[c + 1] = cell
                if row:
                    grid[r + 1] = row
            merges = [f'{_column(c1 + 1)}{r1 + 1}:{_column(c2)}{r2}' for r1, r2, c1, c2 in sheet.merged_cells]
            state = {0: 'visible', 1: 'hidden', 2: 'veryHidden'}.get(sheet.visibility, 'hidden')
            summary, candidates = _table(grid, hidden, merges, f'Workbook@{offset}', sheet.name, state, parsed, context)
            summary['source_format'] = f'BIFF{book.biff_version // 10}'
            if summary.get('missing_fields'):
                missing_labels = '、'.join(_ALIASES[key][0] for key in summary['missing_fields'])
                context.warn(f'{parsed.name} / {sheet.name}: 源表未提供独立字段: {missing_labels}；保持空值，不从其他编号或交货期猜测')
            parsed.sheets.append(summary)
            rows.extend(candidates)
            book.unload_sheet(sheet_index - 1)
        parsed.status = 'parsed' if parsed.sheets and all(s['status'] == 'parsed' for s in parsed.sheets) else 'partial'
        if active or external or log.text.strip():
            parsed.status = 'partial'
            if active:
                context.warn(f'{parsed.name}: XLS 含 VBA/嵌入对象，未执行或解析')
            if external:
                context.warn(f'{parsed.name}: XLS 外部链接未访问，仅读取现有缓存')
            if log.text.strip():
                context.warn(f'{parsed.name}: XLS 读取器报告: {log.text.strip()}')
        return rows
    except (xlrd.XLRDError, CompDocError, AssertionError, RecursionError, TypeError) as exc:
        raise _Invalid(f'XLS 文件损坏或不支持: {exc}') from exc
    finally:
        if book is not None:
            book.release_resources()


def _docx(parts: dict[str, bytes], parsed: ParsedFile, context: _Context) -> None:
    root = _xml(parts['word/document.xml'])
    if _tag(root) != 'document' or _child(root, 'body') is None:
        raise _Invalid('Word 主文档 XML 无效')
    sections = [('word/document.xml', root)]
    for name in sorted(parts):
        if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml', name):
            sections.append((name, _xml(parts[name])))
    texts = []
    has_text = False
    for name, section in sections:
        paragraphs = []
        for paragraph in section.iter():
            if _tag(paragraph) == 'p':
                content = []
                pending = list(reversed(list(paragraph)))
                while pending:
                    node = pending.pop()
                    tag = _tag(node)
                    if tag == 'p':
                        # Text-box paragraphs are visited independently below.
                        continue
                    if tag == 't':
                        content.append(node.text or '')
                    elif tag == 'tab':
                        content.append('\t')
                    elif tag in ('br', 'cr'):
                        content.append('\n')
                    pending.extend(reversed(list(node)))
                if content:
                    paragraphs.append(''.join(content))
        has_text = has_text or any(p.strip() for p in paragraphs)
        texts.append(f'[{name}]\n' + '\n'.join(paragraphs))
    parsed.text = '\n\n'.join(texts)
    parsed.status = 'parsed' if has_text else 'partial'
    if not has_text:
        context.warn(f'{parsed.name}: Word 没有可提取的普通文字；图片或嵌入内容未识别')
    context.warn(f'{parsed.name}: 仅本地提取 Word 普通正文/表格及页眉页脚文字；不渲染、不执行域、不做图片 OCR，不代表已核验完整资质')


def _office_warnings(parts: dict[str, bytes], parsed: ParsedFile, context: _Context) -> None:
    for name, data in parts.items():
        if '/embeddings/' in name or name.lower().endswith('vbaproject.bin') or '/altchunk' in name.lower():
            parsed.status = 'partial'
            warning = f'未解析嵌入或活动内容 {name}（未执行）'
            context.warn(f'{parsed.name}: {warning}')
            context.result.files.append(ParsedFile(
                name=parsed.name + '!/' + name, sha256=hashlib.sha256(data).hexdigest(),
                kind=Path(name).suffix.lstrip('.') or 'unknown', status='unsupported',
                size=len(data), error=warning,
            ))
        if name.endswith('.rels'):
            for relationship in _xml(data):
                if relationship.attrib.get('TargetMode') == 'External':
                    context.warn(f'{parsed.name}: 外部关系未访问（{name}）')


def _visit(data: bytes, name: str, depth: int, context: _Context) -> None:
    suffix = Path(name).suffix.lower()
    parsed = ParsedFile(name=name, sha256=hashlib.sha256(data).hexdigest(), kind=suffix.lstrip('.') or 'unknown',
                        status='pending', size=len(data))
    context.result.files.append(parsed)
    try:
        if len(data) > MAX_FILE_BYTES:
            raise _Limit('单个文件大小超过 30 MiB 限制')
        if suffix == '.xls' or data.startswith((b'\x09\x08', _OLE_SIGNATURE)) and suffix != '.doc':
            parsed.kind = 'xls'
            context.candidates.extend(_xls(data, parsed, context))
            return
        if not data.startswith((b'PK\x03\x04', b'PK\x05\x06')):
            if suffix in ('.zip', '.xlsx', '.docx'):
                raise _Invalid('文件内容不是有效 ZIP / Office Open XML 文件')
            parsed.status = 'unsupported'
            parsed.error = '不支持此文件类型；仅解析 ZIP、XLSX、XLS 和 DOCX'
            context.warn(f'{name}: {parsed.error}')
            return
        archive = _Archive(data, context.budget)
        names = {member.name for member in archive.members}
        if 'xl/workbook.xml' in names and 'word/document.xml' in names:
            raise _Invalid('Office 包同时声明表格与 Word，类型不明确')
        if 'xl/workbook.xml' in names or 'word/document.xml' in names:
            parsed.kind = 'xlsx' if 'xl/workbook.xml' in names else 'docx'
            parts = {}
            for member in archive.members:
                content = archive.read(member)
                if not member.name.endswith('/'):
                    parts[member.name] = content
            if parsed.kind == 'xlsx':
                candidates = _xlsx(parts, parsed, context)
            else:
                _docx(parts, parsed, context)
                candidates = []
            _office_warnings(parts, parsed, context)
            context.candidates.extend(candidates)
        elif suffix in ('.xlsx', '.docx'):
            raise _Invalid('Office 包缺少主文档')
        else:
            parsed.kind = 'zip'
            if depth >= MAX_DEPTH:
                raise _Limit('嵌套 ZIP 层数超过 5 限制')
            if not archive.members:
                parsed.status = 'partial'
                context.warn(f'{name}: 空 ZIP，没有可解析文件')
                return
            before = len(context.result.files)
            for member in archive.members:
                child_name = name + '!/' + member.name
                try:
                    child_data = archive.read(member)
                except (_Invalid, zlib.error) as exc:
                    context.result.files.append(ParsedFile(
                        name=child_name, sha256='', kind=Path(member.name).suffix.lstrip('.') or 'unknown',
                        status='error', size=member.info.file_size, error=str(exc),
                    ))
                    context.warn(f'{child_name}: {exc}')
                    if isinstance(exc, _Limit):
                        raise
                    continue
                if not member.name.endswith('/'):
                    _visit(child_data, child_name, depth + 1, context)
            children = context.result.files[before:]
            parsed.status = 'parsed' if children and all(f.status == 'parsed' for f in children) else 'partial'
    except (zipfile.BadZipFile, zlib.error, ET.ParseError, UnicodeError, ValueError, KeyError, IndexError,
            struct.error, OverflowError, NotImplementedError) as exc:
        parsed.status = 'error'
        parsed.error = str(exc) or type(exc).__name__
        context.warn(f'{name}: {parsed.error}')
        if isinstance(exc, _Limit):
            raise


def _join_key(row: ProjectRow) -> tuple[str, str, str] | None:
    if not row.section or not row.package or not row.request_id:
        return None
    package = _normal(row.package)
    match = re.fullmatch(r'(?:包)?(\d+)(?:包)?', package)
    if match:
        package = str(int(match[1]))
    # Request IDs retain leading zeroes; names and row numbers are never keys.
    return _normal(row.section), package, _normal(row.request_id)


def _combine(context: _Context) -> None:
    canonical: dict[tuple[str, str, str], list[ProjectRow]] = {}
    rows: list[ProjectRow] = []
    demand = [c for c in context.candidates if c.view == 'demand']
    goods = [c for c in context.candidates if c.view == 'goods']
    for candidate in demand:
        row = candidate.row
        rows.append(row)
        key = _join_key(row)
        if key:
            canonical.setdefault(key, []).append(row)
    goods_only: dict[tuple[str, str, str], ProjectRow] = {}
    for candidate in goods:
        row = candidate.row
        key = _join_key(row)
        matches = canonical.get(key, []) if key else []
        if len(matches) == 1:
            # Canonical demand fields are never overwritten by a different view.
            matches[0].evidence.extend(row.evidence)
            matches[0].warnings.extend(w for w in row.warnings if w not in matches[0].warnings)
        elif key and not demand and key in goods_only:
            existing = goods_only[key]
            scalar_names = [f.name for f in fields(ProjectRow) if f.name not in ('evidence', 'warnings')]
            if all(getattr(existing, n) == getattr(row, n) for n in scalar_names):
                existing.evidence.extend(row.evidence)
            else:
                rows.append(row)
                row.warnings.append('同一标识有不同货物明细；保留各行，不按名称或行号猜测')
                context.warn(f'{candidate.file.name}: 同一标识有不同货物明细，需核对')
                candidate.file.status = 'partial'
        else:
            rows.append(row)
            if key:
                goods_only[key] = row
            if demand:
                warning = '货物清单与需求表没有唯一的分标+包号+采购申请标识匹配；保留未关联行'
                row.warnings.append(warning)
                context.warn(f'{candidate.file.name}: {warning}')
                candidate.file.status = 'partial'
    duplicate_keys = {key for key, matches in canonical.items() if len(matches) > 1}
    if duplicate_keys:
        context.warn('需求表存在重复项目标识；未自动合并冲突或重复行')
        for candidate in demand:
            if _join_key(candidate.row) in duplicate_keys:
                candidate.row.warnings.append('需求表出现重复的分标+包号+采购申请标识；保留各行，需人工核对')
                candidate.file.status = 'partial'
    context.result.rows = rows


def parse_file(path: Path | str, filename: str | None = None) -> ParseResult:
    """Parse one trusted caller-selected path containing entirely untrusted data.

    ``complete`` describes supported attachment parsing, not eligibility review.
    Unknown files/sheets, missing formula caches and ambiguous joins are explicit.
    ``Evidence.cells`` maps normalized fields to original cell coordinates;
    ``Evidence.raw['cells']`` retains typed values, exact numeric strings, display
    strings, formats and formulas. Files are never extracted, rendered or run.
    """
    context = _Context()
    source = Path(path)
    name = filename if filename is not None else source.name
    try:
        with source.open('rb') as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise _Limit('输入文件大小超过 30 MiB 限制')
    except (OSError, _Limit) as exc:
        context.result.files.append(ParsedFile(name=name, sha256='', kind='unknown', status='error',
                                               size=0, error=str(exc)))
        context.warn(f'{name}: {exc}')
        return context.result
    try:
        _visit(data, name, 0, context)
    except _Limit:
        pass
    _combine(context)
    # An archive can become partial during cross-file reconciliation.
    for parsed in reversed(context.result.files):
        if parsed.kind == 'zip' and parsed.status == 'parsed':
            if any(f.name.startswith(parsed.name + '!/') and f.status != 'parsed' for f in context.result.files):
                parsed.status = 'partial'
    context.result.complete = bool(context.result.files) and all(f.status == 'parsed' for f in context.result.files)
    return context.result
