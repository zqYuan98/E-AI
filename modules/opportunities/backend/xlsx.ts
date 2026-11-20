// 最小的 .xlsx 写出器：一张表，单元格是文字（内联字符串）、数字或带链接的文字；设好列宽、表头加粗冻结、自动筛选和自动换行。
// .xlsx 是一个 zip，里面几份 XML；zip 用 Node 自带的 zlib 压缩，不引第三方库。
import { crc32, deflateRawSync } from "node:zlib";

export type Cell = string | number | { text: string; link: string } | null;
export interface Sheet { name: string; columns: Array<{ header: string; width: number }>; rows: Cell[][] }

const MAX_CELL = 32_000;
const MAX_LINK = 2_000;

// XML 里不允许的控制字符去掉，五个特殊字符转义。
const xml = (s: string) => s.slice(0, MAX_CELL).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 第 n 列（从 0 起）的列名：A … Z、AA …。 */
function col(n: number): string {
  let s = "";
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

// 样式：0 默认，1 顶端对齐自动换行，2 表头（加粗、底色），3 链接（蓝色下划线、自动换行）。
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="10"/><name val="等线"/></font><font><b/><sz val="10"/><name val="等线"/></font><font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="等线"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet: Sheet): { xml: string; links: string[] } {
  const links: string[] = [];
  const linkRefs: string[] = [];
  const cell = (ref: string, v: Cell, header = false): string => {
    if (v === null || v === "") return "";
    if (typeof v === "number") return `<c r="${ref}" s="1"><v>${v}</v></c>`;
    const text = typeof v === "string" ? v : v.text;
    if (typeof v === "object" && /^https?:\/\//.test(v.link) && v.link.length <= MAX_LINK) {
      links.push(v.link);
      linkRefs.push(`<hyperlink ref="${ref}" r:id="rId${links.length}"/>`);
      return `<c r="${ref}" t="inlineStr" s="3"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
    }
    return `<c r="${ref}" t="inlineStr" s="${header ? 2 : 1}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  };
  const last = `${col(sheet.columns.length - 1)}${sheet.rows.length + 1}`;
  const rows = [
    `<row r="1">${sheet.columns.map((c, k) => cell(`${col(k)}1`, c.header, true)).join("")}</row>`,
    ...sheet.rows.map((r, i) => `<row r="${i + 2}">${r.map((v, k) => cell(`${col(k)}${i + 2}`, v)).join("")}</row>`),
  ];
  return {
    links,
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${sheet.columns.map((c, k) => `<col min="${k + 1}" max="${k + 1}" width="${c.width}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rows.join("")}</sheetData>
<autoFilter ref="A1:${last}"/>
${linkRefs.length ? `<hyperlinks>${linkRefs.join("")}</hyperlinks>` : ""}
</worksheet>`,
  };
}

/** 把几个文件打成 zip（deflate 压缩，文件名 UTF-8，时间固定为 1980-01-01）。 */
function zip(files: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const body = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

export function xlsx(sheet: Sheet): Buffer {
  const { xml: sheetBody, links } = sheetXml(sheet);
  const name = xml(sheet.name.replace(/[\\/?*[\]:']/g, "").slice(0, 31) || "Sheet1");
  const last = `$${col(sheet.columns.length - 1)}$${sheet.rows.length + 1}`;
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name}'!$A$1:${last}</definedName></definedNames></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheetBody],
    ["xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l)}" TargetMode="External"/>`).join("")}</Relationships>`],
  ]);
}
