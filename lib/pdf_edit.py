#!/usr/bin/env python3
"""PDF text editing helpers for Bot Team.

Usage:
  pdf_edit.py read <path> <payload.json>
  pdf_edit.py apply <path> <payload.json>

Always prints a single JSON object on stdout.
"""

import json
import os
import re
import sys
import tempfile


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def fail(message):
    emit({"error": str(message)})
    sys.exit(1)


def read_payload(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        fail(f"读取参数失败: {exc}")


def load_pymupdf():
    try:
        import pymupdf  # type: ignore
        return pymupdf
    except Exception:
        try:
            import fitz  # type: ignore
            return fitz
        except Exception as exc:
            fail(f"缺少 PyMuPDF: {exc}")


def atomic_save(doc, target):
    folder = os.path.dirname(os.path.abspath(target)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".bt-pdf-", suffix=".pdf", dir=folder)
    os.close(fd)
    try:
        doc.save(tmp, garbage=3, deflate=True)
        try:
            os.chmod(tmp, os.stat(target).st_mode)
        except Exception:
            pass
        os.replace(tmp, target)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass


def parse_color(value, pymupdf):
    if value is None:
        return (0, 0, 0)
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return tuple(max(0.0, min(1.0, float(v))) for v in value)
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r"#[0-9a-fA-F]{6}", text):
            return (
                int(text[1:3], 16) / 255,
                int(text[3:5], 16) / 255,
                int(text[5:7], 16) / 255,
            )
        try:
            value = int(text, 0)
        except Exception:
            return (0, 0, 0)
    try:
        number = int(value)
        return ((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255
    except Exception:
        return (0, 0, 0)


def has_cjk(text):
    return bool(re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", str(text or "")))


def font_name(original, text):
    if has_cjk(text):
        return "china-s"
    name = str(original or "").lower()
    if "times" in name or "serif" in name:
        return "tiro"
    if "courier" in name or "mono" in name:
        return "cour"
    return "helv"


def read_pdf(target, payload):
    pymupdf = load_pymupdf()
    try:
        doc = pymupdf.open(target)
    except Exception as exc:
        fail(f"无法读取 PDF: {exc}")
    pages = []
    total = 0
    for page_index, page in enumerate(doc):
        items = []
        try:
            data = page.get_text("dict")
        except Exception:
            data = {}
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                text = "".join(str(span.get("text") or "") for span in spans)
                if not text.strip():
                    continue
                sizes = [float(span.get("size") or 10) for span in spans if str(span.get("text") or "").strip()]
                colors = [int(span.get("color") or 0) for span in spans if str(span.get("text") or "").strip()]
                fonts = [str(span.get("font") or "") for span in spans if str(span.get("text") or "").strip()]
                bbox = line.get("bbox") or block.get("bbox")
                if not bbox:
                    continue
                items.append(
                    {
                        "bbox": [round(float(v), 2) for v in bbox],
                        "text": text,
                        "fontsize": round(max(sizes or [10]), 2),
                        "font": fonts[0] if fonts else "",
                        "color": colors[0] if colors else 0,
                    }
                )
                if len(items) >= 2000:
                    break
            if len(items) >= 2000:
                break
        total += len(items)
        pages.append(
            {
                "index": page_index,
                "width": round(float(page.rect.width), 2),
                "height": round(float(page.rect.height), 2),
                "blocks": items,
            }
        )
    emit({"pages": pages, "pagesCount": len(pages), "blocksCount": total})


def redaction_options(pymupdf):
    kwargs = {}
    try:
        kwargs["images"] = pymupdf.PDF_REDACT_IMAGE_NONE
    except Exception:
        pass
    try:
        kwargs["graphics"] = pymupdf.PDF_REDACT_LINE_ART_NONE
    except Exception:
        pass
    return kwargs


def insert_fitted(page, rect, text, size, color, font, pymupdf):
    if not str(text or ""):
        return
    fontname = font_name(font, text)
    size = max(4.0, min(72.0, float(size or 10)))
    for _ in range(24):
        try:
            left = page.insert_textbox(
                rect,
                str(text),
                fontsize=size,
                fontname=fontname,
                color=color,
                align=0,
                lineheight=1.05,
                overlay=True,
            )
        except Exception:
            left = -1
        if left >= 0:
            return
        size -= 0.5
        if size < 4:
            break
    try:
        page.insert_text(
            (rect.x0, rect.y1 - 1),
            str(text),
            fontsize=max(4.0, size),
            fontname=fontname,
            color=color,
            overlay=True,
        )
    except Exception:
        pass


def apply_pdf(target, payload):
    pymupdf = load_pymupdf()
    try:
        doc = pymupdf.open(target)
    except Exception as exc:
        fail(f"无法读取 PDF: {exc}")

    updates = payload.get("updates") or []
    replacements = payload.get("replacements") or []
    additions = payload.get("additions") or []
    highlights = payload.get("highlights") or []
    if len(updates) + len(replacements) + len(additions) + len(highlights) > 4000:
        fail("一次修改的内容太多")

    by_page = {}
    for item in updates:
        try:
            page_index = int(item.get("page"))
            bbox = [float(v) for v in item.get("bbox") or []]
            if len(bbox) != 4:
                continue
        except Exception:
            continue
        by_page.setdefault(page_index, []).append(
            {
                "rect": pymupdf.Rect(*bbox),
                "text": str(item.get("text") or ""),
                "size": float(item.get("fontsize") or 10),
                "color": parse_color(item.get("color"), pymupdf),
                "font": item.get("font") or "",
            }
        )

    for item in replacements:
        try:
            page_index = int(item.get("page"))
            page = doc[page_index]
            find = str(item.get("find") or "")
            if not find:
                continue
            rects = page.search_for(find)
            if not item.get("all"):
                rects = rects[:1]
            for rect in rects:
                by_page.setdefault(page_index, []).append(
                    {
                        "rect": rect,
                        "text": str(item.get("replace") or ""),
                        "size": float(item.get("fontsize") or 10),
                        "color": parse_color(item.get("color"), pymupdf),
                        "font": "",
                    }
                )
        except Exception:
            continue

    changed = 0
    for page_index, edits in by_page.items():
        if page_index < 0 or page_index >= doc.page_count:
            continue
        page = doc[page_index]
        for edit in edits:
            rect = edit["rect"]
            if rect.is_empty:
                continue
            try:
                page.add_redact_annot(rect, fill=(1, 1, 1))
            except Exception:
                pass
        try:
            page.apply_redactions(**redaction_options(pymupdf))
        except Exception:
            try:
                page.apply_redactions()
            except Exception:
                pass
        for edit in edits:
            if edit["text"]:
                insert_fitted(
                    page,
                    pymupdf.Rect(edit["rect"]),
                    edit["text"],
                    edit["size"],
                    edit["color"],
                    edit["font"],
                    pymupdf,
                )
            changed += 1

    for item in additions:
        try:
            page_index = int(item.get("page"))
            page = doc[page_index]
            x = float(item.get("x") or 72)
            y = float(item.get("y") or 72)
            size = float(item.get("size") or 12)
            text = str(item.get("text") or "")
            if not text:
                continue
            width = float(item.get("width") or 320)
            height = float(item.get("height") or max(24, size * (text.count("\n") + 1) * 1.5))
            rect = pymupdf.Rect(x, y, x + width, y + height)
            insert_fitted(page, rect, text, size, parse_color(item.get("color"), pymupdf), "", pymupdf)
            changed += 1
        except Exception:
            continue

    for item in highlights:
        try:
            page_index = int(item.get("page"))
            page = doc[page_index]
            find = str(item.get("find") or "")
            if not find:
                continue
            rects = page.search_for(find)
            if not item.get("all"):
                rects = rects[:1]
            for rect in rects:
                page.add_highlight_annot(rect)
                changed += 1
        except Exception:
            continue

    try:
        atomic_save(doc, target)
    except Exception as exc:
        fail(f"保存 PDF 失败: {exc}")
    emit({"ok": True, "updated": changed})


def main():
    if len(sys.argv) < 3:
        fail("参数不足")
    action = sys.argv[1]
    target = sys.argv[2]
    payload = {}
    if len(sys.argv) >= 4:
        payload = read_payload(sys.argv[3])
    if not os.path.exists(target):
        fail("文件不存在")
    if action == "read":
        read_pdf(target, payload)
    elif action == "apply":
        apply_pdf(target, payload)
    else:
        fail(f"未知操作: {action}")


if __name__ == "__main__":
    main()
