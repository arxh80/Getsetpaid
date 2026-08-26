"""Print getsetpaid_crm_prd.docx as markdown-ish plain text.

Usage:  python scripts/read-prd.py [path/to/file.docx]

The PRD is the source of truth for this project but is a binary .docx, so it
cannot be grepped or read directly. This dumps it to stdout with headings and
tables preserved well enough to search.
"""

import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
W = "{%s}" % NS["w"]

DEFAULT_PATH = "getsetpaid_crm_prd.docx"


def para_text(p):
    return "".join(t.text or "" for t in p.iter(W + "t"))


def para_style(p):
    style = p.find("w:pPr/w:pStyle", NS)
    return style.get(W + "val") if style is not None else ""


def to_lines(document_xml):
    body = ET.fromstring(document_xml).find("w:body", NS)
    for el in body:
        tag = el.tag.split("}")[1]
        if tag == "p":
            text = para_text(el).strip()
            if not text:
                continue
            style = para_style(el) or ""
            heading = re.match(r"Heading(\d)", style)
            if heading:
                yield "#" * int(heading.group(1)) + " " + text
            elif style == "Title":
                yield "# " + text
            elif "List" in style:
                yield "- " + text
            else:
                yield text
        elif tag == "tbl":
            for row in el.findall("w:tr", NS):
                cells = [
                    " ".join(para_text(p).strip() for p in c.findall("w:p", NS)).strip()
                    for c in row.findall("w:tc", NS)
                ]
                yield "| " + " | ".join(cells) + " |"
            yield ""


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    with zipfile.ZipFile(path) as z:
        document_xml = z.read("word/document.xml")
    out = "\n".join(to_lines(document_xml))
    # Word uses characters cp1252 cannot encode; force UTF-8 on Windows consoles.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(out)


if __name__ == "__main__":
    main()
