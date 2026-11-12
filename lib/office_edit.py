#!/usr/bin/env python3
"""Local Office file helpers for Bot Team.

Usage:
  office_edit.py xlsx-write <path> <payload.json>
  office_edit.py pptx-outline <path> <payload.json>
  office_edit.py pptx-write <path> <payload.json>

The script always prints a single JSON object on stdout.
"""

import json
import os
import re
import sys
import tempfile
from copy import deepcopy


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


def atomic_save(document, target):
    folder = os.path.dirname(os.path.abspath(target)) or "."
    suffix = os.path.splitext(target)[1] or ".tmp"
    fd, tmp = tempfile.mkstemp(prefix=".bt-office-", suffix=suffix, dir=folder)
    os.close(fd)
    try:
        document.save(tmp)
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


def coerce_cell_value(value):
    if value is None:
        return None
    text = str(value)
    if text == "":
        return None
    if text.startswith("="):
        return text
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    # 保留 007 这类前导零文本
    if re.fullmatch(r"-?(0|[1-9]\d*)(\.\d+)?", text) and len(text) <= 18:
        if "." in text:
            return float(text)
        return int(text)
    return text


def xlsx_write(target, payload):
    try:
        import openpyxl
    except Exception as exc:
        fail(f"缺少 openpyxl: {exc}")
    try:
        wb = openpyxl.load_workbook(target, data_only=False)
    except Exception as exc:
        fail(f"无法读取 Excel: {exc}")
    updates = payload.get("updates") or []
    if len(updates) > 50000:
        fail("一次修改的单元格太多")
    updated = 0
    for item in updates:
        sheet = str(item.get("sheet") or "")
        cell = str(item.get("cell") or "")
        if not sheet or not cell:
            continue
        if sheet not in wb.sheetnames:
            fail(f"工作表不存在: {sheet}")
        try:
            wb[sheet][cell] = coerce_cell_value(item.get("value"))
            updated += 1
        except Exception as exc:
            fail(f"写入 {sheet}!{cell} 失败: {exc}")
    try:
        atomic_save(wb, target)
    except Exception as exc:
        fail(f"保存 Excel 失败: {exc}")
    emit({"ok": True, "updated": updated})


def paragraph_text(paragraph):
    return str(paragraph.text or "").replace("\v", "\n")


def iter_leaf_shapes(shapes):
    for shape in shapes:
        try:
            is_group = int(getattr(shape.shape_type, "value", shape.shape_type or 0)) == 6
        except Exception:
            is_group = False
        if is_group:
            try:
                yield from iter_leaf_shapes(shape.shapes)
                continue
            except Exception:
                pass
        yield shape


def collect_paragraphs(prs):
    items = []
    for si, slide in enumerate(prs.slides):
        for shape in iter_leaf_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False):
                try:
                    paragraphs = list(shape.text_frame.paragraphs)
                except Exception:
                    paragraphs = []
                for paragraph in paragraphs:
                    items.append(
                        {
                            "slide": si,
                            "shape": str(getattr(shape, "name", "文本框")),
                            "kind": "text",
                            "row": None,
                            "col": None,
                            "level": int(getattr(paragraph, "level", 0) or 0),
                            "paragraph": paragraph,
                        }
                    )
            if getattr(shape, "has_table", False):
                try:
                    rows = list(shape.table.rows)
                except Exception:
                    rows = []
                for ri, row in enumerate(rows):
                    for ci, cell in enumerate(row.cells):
                        try:
                            paragraphs = list(cell.text_frame.paragraphs)
                        except Exception:
                            paragraphs = []
                        for paragraph in paragraphs:
                            items.append(
                                {
                                    "slide": si,
                                    "shape": str(getattr(shape, "name", "表格")),
                                    "kind": "table",
                                    "row": ri,
                                    "col": ci,
                                    "level": int(getattr(paragraph, "level", 0) or 0),
                                    "paragraph": paragraph,
                                }
                            )
    return items


def pptx_outline(target, payload):
    try:
        from pptx import Presentation
    except Exception as exc:
        fail(f"缺少 python-pptx: {exc}")
    try:
        prs = Presentation(target)
    except Exception as exc:
        fail(f"无法读取 PPT: {exc}")
    items = collect_paragraphs(prs)
    slides = []
    for si, _slide in enumerate(prs.slides):
        group = []
        for index, item in enumerate(items):
            if item["slide"] != si:
                continue
            label = item["shape"]
            if item["kind"] == "table":
                label = f'{label} · R{item["row"] + 1}C{item["col"] + 1}'
            group.append(
                {
                    "index": index,
                    "text": paragraph_text(item["paragraph"]),
                    "shape": label,
                    "kind": item["kind"],
                    "level": item["level"],
                }
            )
        title = next((x["text"].strip() for x in group if x["text"].strip()), "")
        slides.append(
            {
                "index": si,
                "title": (title or f"第 {si + 1} 张")[:80],
                "items": group,
            }
        )
    emit({"slides": slides, "count": len(items)})


def set_paragraph_text(paragraph, text):
    from pptx.oxml.ns import qn

    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\v", "\n")
    runs = list(paragraph.runs)
    rpr = None
    if runs:
        rpr = runs[0]._r.find(qn("a:rPr"))

    for child in list(paragraph._p):
        if child.tag in (qn("a:r"), qn("a:br"), qn("a:fld")):
            paragraph._p.remove(child)

    for line_index, line in enumerate(text.split("\n")):
        if line_index > 0:
            br = paragraph._p.makeelement(qn("a:br"), {})
            paragraph._p.append(br)
        run = paragraph.add_run()
        run.text = line
        if rpr is not None:
            run._r.insert(0, deepcopy(rpr))


def pptx_write(target, payload):
    try:
        from pptx import Presentation
    except Exception as exc:
        fail(f"缺少 python-pptx: {exc}")
    try:
        prs = Presentation(target)
    except Exception as exc:
        fail(f"无法读取 PPT: {exc}")
    items = collect_paragraphs(prs)
    updates = payload.get("paragraphs") or []
    if len(updates) > 20000:
        fail("一次修改的段落太多")
    updated = 0
    for item in updates:
        try:
            index = int(item.get("index"))
        except Exception:
            continue
        if index < 0 or index >= len(items):
            continue
        try:
            set_paragraph_text(items[index]["paragraph"], item.get("text") or "")
            updated += 1
        except Exception as exc:
            fail(f"写入第 {index + 1} 段失败: {exc}")
    try:
        atomic_save(prs, target)
    except Exception as exc:
        fail(f"保存 PPT 失败: {exc}")
    emit({"ok": True, "updated": updated})


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
    if action == "xlsx-write":
        xlsx_write(target, payload)
    elif action == "pptx-outline":
        pptx_outline(target, payload)
    elif action == "pptx-write":
        pptx_write(target, payload)
    else:
        fail(f"未知操作: {action}")


if __name__ == "__main__":
    main()
