from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Evidence:
    file: str
    sheet: str
    row: int
    cells: dict[str, str] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProjectRow:
    batch: str
    section: str
    section_name: str
    package: str
    subpackage: str
    package_name: str
    project_name: str
    buyer: str
    scope: str
    qualifications: str
    personnel: str
    performance: str
    location: str
    deadline: str
    ceiling: str
    ceiling_kind: str
    budget: str
    pricing: str
    request_id: str
    technical_id: str
    consortium: str
    evidence: list[Evidence] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParsedFile:
    name: str
    sha256: str
    kind: str
    status: str
    size: int
    sheets: list[dict[str, Any]] = field(default_factory=list)
    text: str = ''
    error: str = ''


@dataclass
class ParseResult:
    rows: list[ProjectRow] = field(default_factory=list)
    files: list[ParsedFile] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    complete: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Notice:
    source: str
    external_id: str
    url: str
    title: str
    category: str = ''
    buyer: str = ''
    batch: str = ''
    published: str = ''
    deadline: str = ''
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass
class DownloadedNotice:
    notice: Notice
    path: str
    filename: str
    sha256: str
    method: str


class CollectorError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


SOURCE_NAMES = {'ecp': '国网 ECP', 'etp': '电工交易专区'}
