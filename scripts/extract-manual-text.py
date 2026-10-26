"""Extracts the CMS OASIS manual PDF to text for `npm run manual-index`.

Writes one block per page, each preceded by a `=== PAGE n ===` line (n = 1-based PDF page index).
Run:
  python3 -m venv /tmp/v && /tmp/v/bin/pip install pypdf && /tmp/v/bin/python scripts/extract-manual-text.py manual.pdf manual.txt
"""
import sys

from pypdf import PdfReader


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: extract-manual-text.py <manual.pdf> <manual.txt>")
    reader = PdfReader(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as out:
        for n, page in enumerate(reader.pages, 1):
            out.write(f"\n=== PAGE {n} ===\n")
            out.write(page.extract_text() or "")
    print(f"{len(reader.pages)} pages -> {sys.argv[2]}")


if __name__ == "__main__":
    main()
