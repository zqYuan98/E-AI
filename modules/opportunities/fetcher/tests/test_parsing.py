"""Generated XML/ZIP fixtures only; no downloads, binary fixtures or model calls."""
import io
import json
import stat
import struct
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from unittest.mock import patch
from xml.sax.saxutils import escape, quoteattr

from sgcc.parsing import parse_file

S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
HEADERS = ['批次编号', '分标编号', '分标名称', '包号', '子包号', '包名称', '项目名称',
           '建设地点', '采购内容', '响应供应商资质要求', '项目负责人要求', '供应商业绩要求',
           '权重比例', '合同版本', '商务细则', '技术细则', '价格公式', '参数选择', '合同支付比例',
           '工期/服务期（日历天）', '最高限价（万元/折扣率）', '采购估算金额（万元）',
           '报价方式', '一般纳税人适用税率', '项目单位', '采购申请标识', '技术规范书ID', '是否接受联合体应答']
GOODS = ['分标编号', '包名称', '分包编号', '项目单位', '需求单位', '项目名称', '物资名称',
         '数量', '首批交货日期', '最后一批交货日期', '技术规范编码', '网省采购申请号', '总部采购申请号']


def col(number):
    text = ''
    while number:
        number, rest = divmod(number - 1, 26)
        text = chr(65 + rest) + text
    return text


def pack(parts, compression=zipfile.ZIP_DEFLATED):
    target = io.BytesIO()
    with zipfile.ZipFile(target, 'w') as archive:
        items = parts.items() if isinstance(parts, dict) else parts
        for name, data in items:
            # ZIP constructors otherwise read the machine clock. All fixture
            # timestamps are fixed synthetic values, not environment metadata.
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.compress_type = compression
            archive.writestr(info, data.encode() if isinstance(data, str) else data)
    return target.getvalue()


def one_member(name, payload, *, local_name=None, flags=0, local_flags=None, method=8,
               mode=0, claimed_size=None, bad_crc=False, descriptor=False):
    """Produce local/central headers independently to test malformed archives."""
    name = name if isinstance(name, bytes) else name.encode()
    local_name = name if local_name is None else local_name
    local_flags = flags if local_flags is None else local_flags
    if descriptor:
        flags |= 8
        local_flags |= 8
    encoder = zlib.compressobj(wbits=-15)
    data = encoder.compress(payload) + encoder.flush() if method == 8 else payload
    size = len(payload) if claimed_size is None else claimed_size
    crc = zlib.crc32(payload) ^ int(bad_crc)
    local = struct.pack('<4s5H3I2H', b'PK\x03\x04', 20, local_flags, method, 0, 0,
                        0 if descriptor else crc, 0 if descriptor else len(data),
                        0 if descriptor else size, len(local_name), 0) + local_name + data
    if descriptor:
        local += struct.pack('<4sIII', b'PK\x07\x08', crc, len(data), size)
    central = struct.pack('<4s6H3I5H2I', b'PK\x01\x02', (3 << 8) | 20, 20, flags, method,
                          0, 0, crc, len(data), size, len(name), 0, 0, 0, 0, mode << 16, 0) + name
    end = struct.pack('<4s4H2IH', b'PK\x05\x06', 0, 0, 1, 1, len(central), len(local), 0)
    return local + central + end


def demand(package='包1', request='0001', project='技术服务项目', **changes):
    values = dict(zip(HEADERS, ['BATCH', 'SECTION', '零星项目-服务', package, '/', '服务包', project,
                              '来源明确的项目地点', '运维服务', '明确资质', '明确人员', '明确业绩',
                              '60:10:30', '技术服务合同', '细则', '细则', '公式', '参数', '支付比例',
                              '365天', '23.50', '/', '总价报价', '6%', '采购单位', request, 'TECH-001', '否']))
    values.update(changes)
    return [values[h] for h in HEADERS]


def sheet_xml(rows, *, merges=(), dimension='A1', hidden=(), styles=None):
    output = [f'<worksheet xmlns="{S}"><dimension ref={quoteattr(dimension)}/><sheetData>']
    for r, row in enumerate(rows, 1):
        output.append(f'<row r="{r}" hidden="{int(r in hidden)}">')
        for c, value in enumerate(row, 1):
            if value is None:
                continue
            coordinate = f'{col(c)}{r}'
            attrs = f'r="{coordinate}"'
            if isinstance(value, dict):
                kind = value.get('type', 'n')
                attrs += f' t="{kind}" s="{value.get("style", 0)}"'
                body = ''
                if 'formula' in value:
                    body += f'<f>{escape(value["formula"])}</f>'
                if value.get('value') is not None:
                    body += f'<v>{escape(str(value["value"]))}</v>'
                output.append(f'<c {attrs}>{body}</c>')
            elif isinstance(value, (int, float)):
                output.append(f'<c {attrs}><v>{value}</v></c>')
            else:
                output.append(f'<c {attrs} t="inlineStr"><is><t xml:space="preserve">{escape(value)}</t></is></c>')
        output.append('</row>')
    output.append('</sheetData>')
    if merges:
        output.append('<mergeCells>' + ''.join(f'<mergeCell ref="{m}"/>' for m in merges) + '</mergeCells>')
    output.append('</worksheet>')
    return ''.join(output)


def workbook(sheets=None, *, formats=(), extra=None, state='visible'):
    sheets = sheets or [('项目', sheet_xml([HEADERS, demand()]))]
    names = ''.join(f'<sheet name={quoteattr(name)} sheetId="{n}" r:id="rId{n}" state="{state}"/>'
                    for n, (name, _) in enumerate(sheets, 1))
    relationships = ''.join(f'<Relationship Id="rId{n}" Type="{R}/worksheet" Target="worksheets/sheet{n}.xml"/>'
                            for n in range(1, len(sheets) + 1))
    num_formats = ''.join(f'<numFmt numFmtId="{164+n}" formatCode={quoteattr(code)}/>' for n, code in enumerate(formats))
    xfs = '<xf numFmtId="0"/>' + ''.join(f'<xf numFmtId="{164+n}"/>' for n in range(len(formats)))
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'xl/workbook.xml': f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>{names}</sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{P}">{relationships}</Relationships>',
        'xl/styles.xml': f'<styleSheet xmlns="{S}"><numFmts>{num_formats}</numFmts><cellXfs>{xfs}</cellXfs></styleSheet>',
    }
    parts.update({f'xl/worksheets/sheet{n}.xml': content for n, (_, content) in enumerate(sheets, 1)})
    parts.update(extra or {})
    return pack(parts)


def docx(text='通用资格须自行核验', extra=None):
    parts = {'word/document.xml': f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>{escape(text)}</w:t></w:r></w:p></w:body></w:document>'}
    parts.update(extra or {})
    return pack(parts)


def biff_record(code, value=b''):
    return struct.pack('<HH', code, len(value)) + value


def biff_string(value):
    return struct.pack('<HB', len(value), 1) + value.encode('utf-16-le')


def xls_workbook(rows=None, *, formats=(), merges=(), hidden=(), extra_globals=b'',
                 sheet_type=0, bad_dimensions=False):
    """Small real BIFF8 records, not a mocked xlrd workbook or binary fixture."""
    rows = rows or [HEADERS, demand()]
    def bof(kind):
        return biff_record(0x0809, struct.pack('<HHHHII', 0x0600, kind, 0x0DBB, 2000, 0, 6))
    globals_ = bof(5) + biff_record(0x0042, struct.pack('<H', 1200))
    for index, code in enumerate(formats):
        globals_ += biff_record(0x041E, struct.pack('<H', 164 + index) + biff_string(code))
    for code in [0] + [164 + n for n in range(len(formats))]:
        globals_ += biff_record(0x00E0, struct.pack('<HHHBBBBIiH', 0, code, 0, 0, 0, 0, 0, 0, 0, 0))
    globals_ += extra_globals
    name = '项目'
    boundsheet = struct.pack('<IBBB', 0, 0, sheet_type, len(name)) + b'\x01' + name.encode('utf-16-le')
    offset = len(globals_) + 4 + len(boundsheet) + 4
    boundsheet = struct.pack('<I', offset) + boundsheet[4:]
    globals_ += biff_record(0x0085, boundsheet) + biff_record(0x000A)
    sheet = bof(0x10)
    sheet += biff_record(0x0200, struct.pack('<IIHHH', 0, 1 if bad_dimensions else len(rows), 0,
                                           1 if bad_dimensions else max(map(len, rows)), 0))
    for r, row in enumerate(rows):
        if r + 1 in hidden:
            sheet += biff_record(0x0208, struct.pack('<HHHHHHI', r, 0, len(row), 255, 0, 0, 0x20))
        for c, value in enumerate(row):
            if value is None:
                continue
            style = value.get('style', 0) if isinstance(value, dict) else 0
            prefix = struct.pack('<HHH', r, c, style)
            if isinstance(value, dict) and 'formula' in value:
                cache = value.get('cache', struct.pack('<d', value.get('value', 0)))
                tokens = bytes.fromhex(value['formula'])
                sheet += biff_record(value.get('opcode', 0x0006), prefix + cache + struct.pack('<HIH', 0, 0, len(tokens)) + tokens)
                if 'string_cache' in value:
                    sheet += biff_record(0x0207, biff_string(value['string_cache']))
            elif isinstance(value, dict) and 'error' in value:
                sheet += biff_record(0x0205, prefix + bytes([value['error'], 1]))
            elif isinstance(value, (int, float, dict)):
                number = value['value'] if isinstance(value, dict) else value
                sheet += biff_record(0x0203, prefix + struct.pack('<d', number))
            else:
                sheet += biff_record(0x0204, prefix + biff_string(value))
    if merges:
        sheet += biff_record(0x00E5, struct.pack('<H', len(merges)) + b''.join(struct.pack('<HHHH', *m) for m in merges))
    return globals_ + sheet + biff_record(0x000A)


def ole_xls(stream, *, mini=False):
    """Minimal OLE compound document with generated Workbook and FAT streams."""
    sectors = []
    directory = bytearray(512)
    def entry(index, name, kind, start, size, child=-1):
        offset = index * 128
        encoded = name.encode('utf-16-le') + b'\x00\x00'
        directory[offset:offset + len(encoded)] = encoded
        struct.pack_into('<HBBiii', directory, offset + 64, len(encoded), kind, 1, -1, -1, child)
        struct.pack_into('<iQ', directory, offset + 116, start, size)
    if mini:
        if len(stream) >= 4096:
            raise ValueError('mini fixture requires small Workbook')
        blocks = (len(stream) + 63) // 64
        mini_fat = list(range(1, blocks)) + [-2] + [-1] * (128 - blocks)
        sectors.append(b'')  # directory filled below
        sectors.append(struct.pack('<128i', *mini_fat))
        short_data = stream.ljust(((len(stream) + 511) // 512) * 512, b'\x00')
        sectors.extend(short_data[p:p + 512] for p in range(0, len(short_data), 512))
        entry(0, 'Root Entry', 5, 2, len(short_data), 1)
        entry(1, 'Workbook', 2, 0, len(stream))
        fat = [-2, -2] + list(range(3, len(sectors))) + [-2]
    else:
        stream = stream.ljust(max(4096, ((len(stream) + 511) // 512) * 512), b'\x00')
        sectors = [b''] + [stream[p:p + 512] for p in range(0, len(stream), 512)]
        entry(0, 'Root Entry', 5, -2, 0, 1)
        entry(1, 'Workbook', 2, 1, len(stream))
        fat = [-2] + list(range(2, len(sectors))) + [-2]
    sectors[0] = bytes(directory)
    fat_sector = len(sectors)
    fat.append(-3)
    sectors.append(struct.pack('<128i', *(fat + [-1] * (128 - len(fat)))))
    header = bytearray(512)
    header[:8] = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
    struct.pack_into('<HHHHH', header, 24, 0x003E, 3, 0xFFFE, 9, 6)
    struct.pack_into('<IIIIIIIIiI', header, 40, 0, 1, 0, 0, 4096, 1 if mini else 0xFFFFFFFE,
                     1 if mini else 0, 0xFFFFFFFE, 0, fat_sector)
    struct.pack_into('<109i', header, 76, fat_sector, *([-1] * 108))
    return bytes(header) + b''.join(sectors)


class ParsingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'input.bin'

    def parse(self, data, name='sample.zip'):
        self.path.write_bytes(data)
        return parse_file(self.path, name)

    def assert_rejected(self, result):
        self.assertFalse(result.complete)
        self.assertTrue(result.warnings)
        self.assertTrue(any(f.status in ('error', 'partial', 'unsupported') for f in result.files))

    def test_native_biff8_and_ole_xls_reuse_contract_and_evidence(self):
        data = xls_workbook(bad_dimensions=True)
        for payload in (data, ole_xls(data), ole_xls(data, mini=True)):
            with self.subTest(size=len(payload)):
                result = self.parse(payload, 'native.xls')
                self.assertTrue(result.complete, result.warnings)
                self.assertEqual(len(result.rows), 1)
                row = result.rows[0]
                self.assertEqual(row.request_id, '0001')
                self.assertEqual(row.qualifications, '明确资质')
                self.assertEqual(row.ceiling, '23.50')
                self.assertEqual(row.evidence[0].row, 2)
                self.assertEqual(row.evidence[0].cells['scope'], 'I2')
                self.assertEqual(row.evidence[0].raw['cells']['I2']['source_format'], 'BIFF8')

    def test_province_template_package_name_as_project_and_two_row_header(self):
        # 国网四川“项目概况与资质业绩要求”：没有“项目名称”列，项目名在“包名称”；资格要求是两行表头。
        headers = ['序号', '采购编号', '分标编号', '分标名称', '包号', '包名称', '子项目名称', '网省采购申请行号',
                   '最高限价(万元)（含税）', '报价方式', '需求单位', '项目概况', '响应供应商专用资格要求', '']
        sub = ['', '', '', '', '', '', '', '', '', '', '', '', '资质要求', '业绩要求']
        record = ['1', 'S-100', 'S-100', '业务运营服务', '包1', '泸州供电公司2026年RPA支撑服务', '/', '3400213830',
                  '26.5', '固定总价', '泸州供电公司', '部署RPA流程机器人', '/', '具有软件开发业绩']
        result = self.parse(xls_workbook([['项目概况与资质业绩要求'], headers, sub, record]), 'sichuan.xls')
        self.assertEqual(len(result.rows), 1, result.warnings)
        row = result.rows[0]
        self.assertEqual(row.project_name, '泸州供电公司2026年RPA支撑服务')
        self.assertEqual(row.scope, '部署RPA流程机器人')
        self.assertEqual((row.qualifications, row.performance), ('/', '具有软件开发业绩'))
        self.assertEqual((row.ceiling, row.ceiling_kind), ('26.5', 'amount_wan'))
        self.assertEqual(row.request_id, '3400213830')
        self.assertFalse(any('无法识别为项目' in w for w in result.warnings), result.warnings)

    def test_etp_header_yuan_amounts_and_missing_ids_not_invented(self):
        headers = ['标段 ', '分包', '采购人', '采购项目编号', '采购项目名称', '分标名称',
                   '分包名称', '物料（服务）名称', '最高限价（元）', '交货期', '交货地点',
                   ' 专用资格要求/业绩资质要求', '是否接受代理商']
        records = [[f'标{i}', '包1', '采购人', 'SHARED-PROJECT-ID', '共同项目名称', f'设备{i}',
                    f'包1设备{i}', f'设备内容{i}', amount, '合同签订30天内', '指定交货地点', '原始资格和业绩原文', '否']
                   for i, amount in enumerate([40000, 288600, 280000, 138000, 50000, 102000], 1)]
        data = pack({'inner.zip': pack({'项目需求.xls': ole_xls(xls_workbook([['项目采购需求清单'], headers] + records)),
                                      'notice.docx': docx()})})
        result = self.parse(data)
        self.assert_rejected(result)  # Supported rows, but request IDs are absent.
        self.assertEqual(len(result.rows), 6)
        self.assertEqual(len({(r.section, r.package) for r in result.rows}), 6)
        self.assertEqual(result.rows[0].ceiling, '40000')
        self.assertEqual(result.rows[0].ceiling_kind, 'amount_yuan')
        self.assertEqual(result.rows[1].ceiling, '288600')
        self.assertEqual(result.rows[1].evidence[0].raw['normalized_amount_wan'], '28.86')
        self.assertTrue(all(r.request_id == r.deadline == r.batch == '' for r in result.rows))
        self.assertEqual(result.rows[0].qualifications, '原始资格和业绩原文')
        self.assertIn('SHARED-PROJECT-ID', result.rows[0].evidence[0].raw['extra'].values())
        self.assertEqual(result.rows[0].evidence[0].row, 3)
        self.assertEqual(result.rows[0].evidence[0].raw['cells']['I3']['numeric'], 40000)

    def test_xls_numeric_percent_zero_styles_hidden_and_explicit_merges(self):
        first, second = demand('包1', 'R1'), demand('包2', 'R2')
        first[20] = {'value': 0.955, 'style': 1}
        second[20] = {'value': 0.875, 'style': 1}
        first[25] = {'value': 12, 'style': 2}
        second[9] = None
        result = self.parse(xls_workbook([HEADERS, first, second], formats=['0.0%', '000000'],
                                         merges=[(1, 2, 9, 9)], hidden=[3]), 'styled.xls')
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual(result.rows[0].ceiling, '95.5%')
        self.assertEqual(result.rows[0].ceiling_kind, 'percent')
        self.assertEqual(result.rows[0].request_id, '000012')
        self.assertEqual(result.rows[1].qualifications, '明确资质')
        self.assertEqual(result.rows[1].evidence[0].cells['qualifications'], 'J2')
        self.assertTrue(result.rows[1].evidence[0].raw['hidden_row'])

    def test_xls_formula_uses_cache_without_calculation_and_flags_unverified(self):
        first, second = demand('包1', 'R1'), demand('包2', 'R2')
        first[20] = {'formula': '1e01001e020003', 'value': 999}  # 1+2, deliberately stale cache.
        second[20] = {'formula': '1e0100', 'cache': b'\x02\x00\x07\x00\x00\x00\xff\xff'}
        result = self.parse(xls_workbook([HEADERS, first, second]), 'formulas.xls')
        self.assert_rejected(result)
        self.assertEqual(result.rows[0].ceiling, '999')
        self.assertEqual(result.rows[1].ceiling, '')
        self.assertEqual(result.rows[1].ceiling_kind, 'unknown')
        evidence = result.rows[0].evidence[0].raw['cells']['U2']
        self.assertEqual(evidence['formula_tokens_hex'], '1e01001e020003')
        self.assertFalse(evidence['formula_evaluated'])
        self.assertFalse(evidence['cached_verified'])
        self.assertTrue(evidence['cached'])
        self.assertTrue(any('缓存' in warning for warning in result.rows[0].warnings))

    def test_xls_formula_opcode_variants_never_look_like_verified_constants(self):
        for opcode in (0x0206, 0x0406):
            with self.subTest(opcode=opcode):
                row = demand()
                row[20] = {'formula': '1e0100', 'value': 5, 'opcode': opcode}
                result = self.parse(xls_workbook([HEADERS, row]), 'formula-variant.xls')
                self.assert_rejected(result)
                self.assertEqual(result.rows[0].ceiling, '5')
                self.assertFalse(result.rows[0].evidence[0].raw['cells']['U2']['cached_verified'])

    def test_xls_formula_string_cache_missing_and_truncated_are_explicit(self):
        row = demand()
        row[20] = {'formula': '1e0100', 'cache': b'\x00\x00\x00\x00\x00\x00\xff\xff', 'string_cache': '12.50'}
        result = self.parse(xls_workbook([HEADERS, row]), 'string-cache.xls')
        self.assertEqual(result.rows[0].ceiling, '12.50')
        self.assert_rejected(result)  # Cache retained, not verified.
        del row[20]['string_cache']
        result = self.parse(xls_workbook([HEADERS, row]), 'missing-cache.xls')
        self.assert_rejected(result)
        self.assertTrue(any('缺少 STRING 缓存' in w for w in result.warnings))
        self.assert_rejected(self.parse(xls_workbook()[:-3], 'truncated.xls'))
        self.assert_rejected(self.parse(b'<html>not xls</html>', 'fake.xls'))

    def test_xls_encryption_macros_external_links_and_sparse_limits(self):
        encrypted = xls_workbook(extra_globals=biff_record(0x002F, b'\x00\x00'))
        result = self.parse(encrypted, 'encrypted.xls')
        self.assert_rejected(result)
        self.assertTrue(any('FILEPASS' in w for w in result.warnings))
        self.assert_rejected(self.parse(xls_workbook(sheet_type=1), 'macro.xls'))
        external = xls_workbook(extra_globals=biff_record(0x01AE, struct.pack('<H', 1) + biff_string('\\external\\never')))
        result = self.parse(external, 'external.xls')
        self.assert_rejected(result)
        self.assertEqual(len(result.rows), 1)
        self.assertTrue(any('外部链接未访问' in w for w in result.warnings))
        with patch('sgcc.parsing._MAX_CELLS', 30):
            self.assert_rejected(self.parse(xls_workbook(), 'too-many.xls'))
        self.assert_rejected(self.parse(xls_workbook(merges=[(0, 65535, 0, 255)]), 'huge-merge.xls'))

    def test_xls_ole_mini_fat_cycle_directory_cycle_and_size_lies_rejected(self):
        data = bytearray(ole_xls(xls_workbook(), mini=True))
        struct.pack_into('<i', data, 512 * 2, 0)  # Mini-FAT first stream sector points to itself.
        result = self.parse(bytes(data), 'cycle.xls')
        self.assert_rejected(result)
        self.assertTrue(any('扇区链循环' in w for w in result.warnings))
        data = bytearray(ole_xls(xls_workbook()))
        struct.pack_into('<i', data, 512 + 128 + 68, 1)  # Directory left sibling points to itself.
        self.assert_rejected(self.parse(bytes(data), 'directory-cycle.xls'))
        data = bytearray(ole_xls(xls_workbook()))
        struct.pack_into('<Q', data, 512 + 128 + 120, 100 * 1024 * 1024)
        self.assert_rejected(self.parse(bytes(data), 'size-lie.xls'))

    def test_direct_xlsx_ignores_wrong_dimensions_and_records_evidence(self):
        result = self.parse(workbook([('服务', sheet_xml([HEADERS, demand(), demand('包2', '0002')]))]), 'demand.xlsx')
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual(len(result.rows), 2)
        row = result.rows[1]
        self.assertEqual(row.package, '包2')
        self.assertEqual(row.deadline, '')  # A service period is NOT a bidding deadline.
        self.assertEqual(row.request_id, '0002')
        self.assertEqual(row.ceiling, '23.50')
        self.assertEqual(row.ceiling_kind, 'amount_wan')
        self.assertEqual(row.evidence[0].file, 'demand.xlsx')
        self.assertEqual(row.evidence[0].sheet, '服务')
        self.assertEqual(row.evidence[0].row, 3)
        self.assertEqual(row.evidence[0].cells['scope'], 'I3')
        self.assertEqual(row.evidence[0].raw['cells']['I3']['value'], '运维服务')
        self.assertIn('365天', row.evidence[0].raw['extra'].values())
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)
        json.dumps(result.to_dict(), ensure_ascii=False, allow_nan=False)

    def test_nested_zip_and_docx_text_without_execution(self):
        inner = pack({'目录/需求一览表.xlsx': workbook(), '目录/公告.docx': docx()})
        result = self.parse(pack({'nested.zip': inner}), 'download.bin')
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual(len(result.rows), 1)
        self.assertEqual([f.kind for f in result.files], ['zip', 'zip', 'xlsx', 'docx'])
        self.assertIn('通用资格须自行核验', result.files[-1].text)
        self.assertIn('!/nested.zip!/目录/需求一览表.xlsx', result.rows[0].evidence[0].file)

    def test_known_gb18030_directory_utf8_local_names_only_when_agree(self):
        name = '货物清单.xlsx'
        data = one_member(name.encode('gb18030'), workbook(), local_name=name.encode(), local_flags=0x800, descriptor=True)
        result = self.parse(data)
        self.assertTrue(result.complete, result.warnings)
        self.assertTrue(result.files[1].name.endswith(name))
        mismatch = one_member(name.encode('gb18030'), workbook(), local_name='另一文件.xlsx'.encode(), local_flags=0x800)
        result = self.parse(mismatch)
        self.assert_rejected(result)
        self.assertFalse(result.rows)

    def test_gb18030_zip_and_ordinary_utf8_members(self):
        for raw, flags in [('需求.xlsx'.encode('gb18030'), 0), ('需求.xlsx'.encode(), 0x800)]:
            with self.subTest(flags=flags):
                result = self.parse(one_member(raw, workbook(), flags=flags))
                self.assertTrue(result.complete, result.warnings)
                self.assertIn('需求.xlsx', result.files[1].name)

    def test_zip_paths_are_rejected_in_both_headers(self):
        bad_names = ['../outside.xlsx', '/outside.xlsx', 'C:/outside.xlsx', 'C:outside.xlsx',
                     '..\\outside.xlsx', '\\\\server\\share.xlsx', 'folder/../outside.xlsx',
                     'folder/./file.xlsx', 'folder//file.xlsx', 'folder/file.xlsx:stream',
                     'bad\x00.xlsx', 'folder/CON.txt', 'folder /file.xlsx']
        for name in bad_names:
            with self.subTest(name=name):
                self.assert_rejected(self.parse(one_member(name.encode(), b'x')))
        self.assert_rejected(self.parse(one_member(b'safe.xlsx', workbook(), local_name=b'../bad.xlsx')))
        self.assertFalse((Path(self.temp.name).parent / 'outside.xlsx').exists())

    def test_symlink_encrypted_unsupported_method_and_unknown_flags(self):
        variants = [dict(mode=stat.S_IFLNK | 0o777), dict(mode=stat.S_IFIFO | 0o600),
                    dict(flags=1), dict(flags=0x40), dict(local_flags=1), dict(method=12)]
        for options in variants:
            with self.subTest(options=options):
                self.assert_rejected(self.parse(one_member('a.xlsx', workbook(), **options)))

    def test_crc_truncation_local_header_and_descriptor_errors(self):
        self.assert_rejected(self.parse(one_member('a.xlsx', workbook(), bad_crc=True)))
        correct = one_member('a.xlsx', workbook(), descriptor=True)
        self.assertTrue(self.parse(correct).complete)
        self.assert_rejected(self.parse(correct[:-8]))
        corrupted = bytearray(correct)
        descriptor = corrupted.find(b'PK\x07\x08')
        corrupted[descriptor + 4] ^= 1
        self.assert_rejected(self.parse(bytes(corrupted)))
        corrupted = bytearray(one_member('a.xlsx', workbook()))
        struct.pack_into('<I', corrupted, 22, 1)
        self.assert_rejected(self.parse(bytes(corrupted)))

    def test_actual_inflation_is_bounded_even_when_declared_size_is_small(self):
        data = one_member('bomb.txt', b'A' * 20000, claimed_size=1)
        with patch('sgcc.parsing.MAX_FILE_BYTES', 1024):
            result = self.parse(data)
        self.assert_rejected(result)
        self.assertIn('实际解压', ' '.join(result.warnings))
        self.assert_rejected(self.parse(one_member('lie.txt', b'actual bytes', claimed_size=1)))

    def test_cumulative_bytes_count_and_depth_limits(self):
        with patch('sgcc.parsing.MAX_TOTAL_BYTES', 100):
            self.assert_rejected(self.parse(pack({'one.txt': b'a' * 60, 'two.txt': b'b' * 60})))
        with patch('sgcc.parsing.MAX_FILES', 2):
            self.assert_rejected(self.parse(pack({'a.txt': b'a', 'b.txt': b'b', 'c.txt': b'c'})))
        data = workbook()
        for _ in range(5):
            data = pack({'child.zip': data})
        self.assertTrue(self.parse(data).complete)
        self.assert_rejected(self.parse(pack({'too-deep.zip': data})))
        with patch('sgcc.parsing.MAX_FILE_BYTES', 20):
            self.assert_rejected(self.parse(b'x' * 21))

    def test_central_directory_count_lie_duplicate_and_overlap(self):
        data = bytearray(pack({'a.txt': b'a', 'b.txt': b'b'}))
        end = data.rfind(b'PK\x05\x06')
        struct.pack_into('<HH', data, end + 8, 1, 1)
        self.assert_rejected(self.parse(bytes(data)))
        with self.assertWarns(UserWarning):
            duplicate = pack([('same.txt', 'a'), ('same.txt', 'b')])
        self.assert_rejected(self.parse(duplicate))
        data = bytearray(pack({'a.txt': b'a', 'b.txt': b'b'}))
        first = data.find(b'PK\x01\x02')
        second = data.find(b'PK\x01\x02', first + 4)
        struct.pack_into('<I', data, second + 42, 0)
        self.assert_rejected(self.parse(bytes(data)))

    def test_merges_only_cross_package_qualifications_and_no_forward_fill(self):
        rows = [HEADERS, demand('包1', 'R1'), demand('包2', 'R2'), demand('包3', 'R3')]
        rows[2][9] = None
        rows[3][9] = None
        result = self.parse(workbook([('服务', sheet_xml(rows, merges=['J2:J3']))]), 'demand.xlsx')
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual([r.qualifications for r in result.rows], ['明确资质', '明确资质', ''])
        evidence = result.rows[1].evidence[0]
        self.assertEqual(evidence.cells['qualifications'], 'J2')
        self.assertEqual(evidence.raw['merges']['J3'], {'range': 'J2:J3', 'anchor': 'J2'})
        self.assertEqual(evidence.raw['cells']['J2']['value'], '明确资质')
        self.assertEqual(result.files[0].sheets[0]['merge_count'], 1)

    def test_merged_packages_keep_every_project_row(self):
        rows = [HEADERS] + [demand('包9', f'R{i}') for i in range(15)]
        for row in rows[2:]:
            row[3] = None
        result = self.parse(workbook([('服务', sheet_xml(rows, merges=['D2:D16']))]), 'demand.xlsx')
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual(len(result.rows), 15)
        self.assertEqual({r.package for r in result.rows}, {'包9'})
        self.assertEqual(result.rows[-1].evidence[0].cells['package'], 'D2')

    def test_percent_amount_numeric_precision_leading_zeroes_and_hidden_rows(self):
        row = demand()
        row[20] = {'value': '0.9575', 'style': 1}
        row[21] = {'value': '1234.5', 'style': 3}
        row[25] = {'value': '23', 'style': 2}
        row[22] = '折扣率报价'
        result = self.parse(workbook([('隐藏服务', sheet_xml([HEADERS, row], hidden=[2]))],
                                     formats=['0.00%', '000000', '#,##0.00'], state='hidden'), 'rates.xlsx')
        self.assertTrue(result.complete, result.warnings)
        parsed = result.rows[0]
        self.assertEqual(parsed.ceiling, '95.75%')
        self.assertEqual(parsed.ceiling_kind, 'percent')
        self.assertEqual(parsed.budget, '1,234.50')
        self.assertEqual(parsed.request_id, '000023')
        raw = parsed.evidence[0].raw
        self.assertTrue(raw['hidden_row'])
        self.assertTrue(raw['hidden_sheet'])
        self.assertEqual(raw['cells']['U2']['numeric'], 0.9575)
        self.assertEqual(raw['cells']['U2']['numeric_text'], '0.9575')
        self.assertEqual(raw['cells']['U2']['number_format'], '0.00%')
        self.assertEqual(raw['cells']['Z2']['numeric'], 23)

    def test_reordered_normalized_headers_are_not_fixed_positions(self):
        headers = [HEADERS[25], ' 分 标 编 号\n', HEADERS[6], '包 号', '采购内容',
                   '最高限价（万元）', '投标截止时间']
        values = ['0000123', 'S', '项目', '包2', '内容', 8.5, '2030-01-02 10:00']
        result = self.parse(workbook([('重排', sheet_xml([headers, values]))]), 'reordered.xlsx')
        self.assertTrue(result.complete, result.warnings)
        row = result.rows[0]
        self.assertEqual((row.section, row.package, row.request_id), ('S', '包2', '0000123'))
        self.assertEqual(row.ceiling, '8.5')
        self.assertEqual(row.ceiling_kind, 'amount_wan')
        self.assertEqual(row.deadline, '2030-01-02 10:00')
        self.assertEqual(row.evidence[0].cells['request_id'], 'A2')

    def test_formula_no_execution_missing_cache_unknown_and_cached_value_retained(self):
        first = demand('包1', 'R1')
        first[20] = {'formula': 'WEBSERVICE("https://invalid.example/never")'}
        second = demand('包2', 'R2')
        second[20] = {'formula': '10+20', 'value': 30}
        result = self.parse(workbook([('公式', sheet_xml([HEADERS, first, second]))]), 'formula.xlsx')
        self.assert_rejected(result)
        self.assertEqual(result.rows[0].ceiling, '')
        self.assertEqual(result.rows[0].ceiling_kind, 'unknown')
        self.assertEqual(result.rows[1].ceiling, '30')
        raw = result.rows[0].evidence[0].raw['cells']['U2']
        self.assertFalse(raw['cached'])
        self.assertFalse(raw['formula_evaluated'])
        self.assertIn('WEBSERVICE', raw['formula'])
        self.assertTrue(result.rows[1].evidence[0].raw['cells']['U3']['cached'])

    def test_goods_and_demand_join_by_section_package_request_not_name_or_row(self):
        demand_rows = [HEADERS, demand('包9', '001', '需求项目甲'), demand('包9', '002', '需求项目乙')]
        goods_rows = [GOODS,
                      ['SECTION', '包9', 'HN9', '总公司', '采购单位', '不同名称乙', '物料乙', '2', '2030-03-01', '2031-03-01', 'TECH2', '002', 'HQ2'],
                      ['SECTION', '包9', 'HN9', '总公司', '采购单位', '不同名称甲', '物料甲', '3', '2030-03-01', '2031-03-01', 'TECH1', '001', 'HQ1']]
        data = pack({'goods.xlsx': workbook([('货物', sheet_xml(goods_rows))]),
                     'nested.zip': pack({'需求.xlsx': workbook([('服务', sheet_xml(demand_rows))])})})
        result = self.parse(data)
        self.assertTrue(result.complete, result.warnings)
        self.assertEqual(len(result.rows), 2)
        self.assertEqual([r.project_name for r in result.rows], ['需求项目甲', '需求项目乙'])
        self.assertEqual([len(r.evidence) for r in result.rows], [2, 2])
        self.assertEqual(result.rows[0].evidence[1].row, 3)
        self.assertEqual(result.rows[1].evidence[1].row, 2)
        self.assertEqual(result.rows[0].evidence[1].cells['scope'], 'G3')  # 物资名称
        self.assertEqual(result.rows[0].deadline, '')

    def test_ambiguous_and_unmatched_join_are_not_silently_complete(self):
        duplicate_rows = [HEADERS, demand(), demand()]
        goods = [GOODS, ['SECTION', '包1', 'HN1', '总公司', '买方', '项目', '物料', 1, '', '', 'T', '0001', 'H']]
        result = self.parse(pack({'demand.xlsx': workbook([('需求', sheet_xml(duplicate_rows))]),
                                  'goods.xlsx': workbook([('货物', sheet_xml(goods))])}))
        self.assert_rejected(result)
        self.assertEqual(len(result.rows), 3)
        self.assertTrue(all(len(r.evidence) == 1 for r in result.rows))
        goods[1][-2] = 'NOT-THE-SAME'
        result = self.parse(pack({'demand.xlsx': workbook(), 'goods.xlsx': workbook([('货物', sheet_xml(goods))])}))
        self.assert_rejected(result)
        self.assertEqual(len(result.rows), 2)

    def test_unknown_schema_empty_workbook_and_unsupported_file_explicit(self):
        result = self.parse(pack({'unknown.xlsx': workbook([('陌生表', sheet_xml([['其他字段'], ['数据']]))]),
                                 'readme.pdf': b'%PDF-unsupported', 'valid.xlsx': workbook()}))
        self.assert_rejected(result)
        self.assertEqual(len(result.rows), 1)
        self.assertEqual(result.files[1].sheets[0]['status'], 'unsupported')
        self.assertEqual(result.files[2].status, 'unsupported')
        self.assert_rejected(self.parse(workbook([('空表', sheet_xml([HEADERS]))]), 'empty.xlsx'))
        self.assert_rejected(self.parse(pack({}), 'empty.zip'))
        self.assert_rejected(self.parse(b'not a spreadsheet', 'broken.xlsx'))
        missing = parse_file(Path(self.temp.name) / 'missing.xlsx')
        self.assert_rejected(missing)

    def test_external_sheet_relationship_missing_parts_and_xml_entities(self):
        external = f'<Relationships xmlns="{P}"><Relationship Id="rId1" Type="{R}/worksheet" Target="https://invalid.example/never" TargetMode="External"/></Relationships>'
        result = self.parse(workbook(extra={'xl/_rels/workbook.xml.rels': external}), 'external.xlsx')
        self.assert_rejected(result)
        self.assertFalse(result.rows)
        malicious = f'<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///do-not-read">]><worksheet xmlns="{S}"><sheetData>&x;</sheetData></worksheet>'
        self.assert_rejected(self.parse(workbook([('实体', malicious)]), 'entity.xlsx'))
        entity_doc = f'<!DOCTYPE document [<!ENTITY x "expanded">]><w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>'
        self.assert_rejected(self.parse(docx(extra={'word/document.xml': entity_doc}), 'entity.docx'))
        self.assert_rejected(self.parse(workbook(extra={'xl/workbook.xml': '<workbook/>'}), 'missing.xlsx'))

    def test_embedded_word_content_is_reported_without_execution(self):
        document = f'<w:document xmlns:w="{W}"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格资格</w:t><w:tab/><w:t>要求</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:instrText>INCLUDETEXT never</w:instrText><w:t>缓存文字</w:t></w:r></w:p></w:body></w:document>'
        result = self.parse(docx(extra={'word/document.xml': document, 'word/embeddings/oleObject1.bin': b'not executed'}), 'notice.docx')
        self.assert_rejected(result)
        self.assertIn('表格资格\t要求', result.files[0].text)
        self.assertIn('缓存文字', result.files[0].text)
        self.assertNotIn('INCLUDETEXT', result.files[0].text)
        self.assertTrue(any('oleObject1.bin' in w for w in result.warnings))

    def test_invalid_merge_giant_range_unknown_format_and_error_cell(self):
        for merge in ['A1:XFD1048576', 'J3:J2', 'bad']:
            with self.subTest(merge=merge):
                self.assert_rejected(self.parse(workbook([('合并', sheet_xml([HEADERS, demand()], merges=[merge]))]), 'bad.xlsx'))
        row = demand()
        row[20] = {'value': '1', 'style': 1}
        result = self.parse(workbook([('格式', sheet_xml([HEADERS, row]))], formats=['[Red]0.00']), 'format.xlsx')
        self.assert_rejected(result)
        self.assertEqual(result.rows[0].evidence[0].raw['cells']['U2']['number_format'], '[Red]0.00')
        row[20] = {'type': 'e', 'value': '#VALUE!'}
        result = self.parse(workbook([('错误', sheet_xml([HEADERS, row]))]), 'error.xlsx')
        self.assert_rejected(result)
        self.assertEqual(result.rows[0].ceiling_kind, 'unknown')

    def test_shared_string_expansion_is_bounded_separately_from_zip_bytes(self):
        row = demand()
        row[8] = {'type': 's', 'value': 0}
        strings = f'<sst xmlns="{S}"><si><t>{"X" * 20000}</t></si></sst>'
        data = workbook([('重复文本', sheet_xml([HEADERS] + [row for _ in range(100)]))],
                        extra={'xl/sharedStrings.xml': strings})
        with patch('sgcc.parsing.MAX_TOTAL_BYTES', 1024 * 1024):
            result = self.parse(data, 'strings.xlsx')
        self.assert_rejected(result)
        self.assertTrue(any('展开文本' in w for w in result.warnings))

    def test_corrupt_member_does_not_hide_valid_sibling(self):
        data = bytearray(pack({'corrupt.txt': b'bad', 'valid.xlsx': workbook()}, compression=zipfile.ZIP_STORED))
        first_name_length = struct.unpack_from('<H', data, 26)[0]
        data[30 + first_name_length] ^= 1
        result = self.parse(bytes(data))
        self.assert_rejected(result)
        self.assertEqual(result.files[1].status, 'error')
        self.assertIn('CRC', result.files[1].error)
        self.assertEqual(len(result.rows), 1)
        self.assertEqual(result.files[2].status, 'parsed')

    def test_no_implicit_identity_fill_and_unknown_ceiling_units(self):
        first, second = demand('包1', 'R1'), demand('包2', 'R2')
        second[1] = ''
        second[22] = ''
        result = self.parse(workbook([('缺失字段', sheet_xml([HEADERS, first, second]))]), 'missing-fields.xlsx')
        self.assert_rejected(result)
        self.assertEqual(result.rows[1].section, '')
        self.assertEqual(result.rows[1].ceiling_kind, 'unknown')
        self.assertTrue(result.rows[1].warnings)

    def test_empty_word_and_external_links_remain_explicit(self):
        result = self.parse(docx(''), 'empty.docx')
        self.assert_rejected(result)
        external = f'<Relationships xmlns="{P}"><Relationship Id="link" Type="{R}/hyperlink" Target="https://invalid.example/never" TargetMode="External"/></Relationships>'
        result = self.parse(docx(extra={'word/_rels/document.xml.rels': external}), 'links.docx')
        self.assertTrue(result.complete, result.warnings)
        self.assertTrue(any('外部关系未访问' in w for w in result.warnings))

    def test_shared_strings_text_and_partial_sheet_failure_keep_valid_sheet(self):
        row = demand()
        row[6] = {'type': 's', 'value': 0}
        strings = f'<sst xmlns="{S}"><si><r><t>共享</t></r><r><t>项目</t></r></si></sst>'
        result = self.parse(workbook([('有效', sheet_xml([HEADERS, row])), ('损坏', '<worksheet>')],
                                     extra={'xl/sharedStrings.xml': strings}), 'mixed.xlsx')
        self.assert_rejected(result)
        self.assertEqual(len(result.rows), 1)
        self.assertEqual(result.rows[0].project_name, '共享项目')
        self.assertEqual(result.files[0].sheets[1]['status'], 'error')


if __name__ == '__main__':
    unittest.main()
