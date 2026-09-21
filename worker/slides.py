#!/usr/bin/env python3
"""Slide renderer: one 1920x1080 PNG per slide spec, through headless Chromium.

Two modes share one renderer:

- layouts: the agent picks a layout and writes the words; the template below
  owns pixels, fonts and colors, so every video of a channel looks related.
- html: the agent writes the slide itself (inline CSS/SVG). The page only
  provides the theme variables and fonts, so what comes out is the agent's
  design, which is exactly what this mode exists to test.

Specs arrive aligned 1:1 with the script blocks; a null entry is a face-cam
block (full-frame avatar) and gets no slide.

Rendering is sandboxed: JavaScript off, and every request that is not data:
or about: is aborted, so agent-written HTML cannot fetch anything.

Safe area: content stays inside x 80..1840, y 60..760. The band y 780..900
carries the burned karaoke captions and the bottom-right corner carries the
avatar bubble, so the lower-right of the safe area (x > 1500, y > 680) stays
empty too.

CLI:
    python3 worker/slides.py slides.json out_dir [--site agentwrotethis.dev]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

class SlideSpecError(ValueError):
    """A malformed slide spec: the same input fails the same way every time.
    Its own type so callers can tell it from a ValueError raised elsewhere
    (a JSON or Unicode decode in a network response is one, and is transient)."""


WIDTH, HEIGHT = 1920, 1080
TIMEOUT_MS = 15_000

THEME_CSS = """
:root {
  --bg: #0F0F23;
  --fg: #FFFFFF;
  --muted: #9696AA;
  --accent: #8B5CF6;
  --hl: #34D399;
  --panel: #17172F;
  --font: "Inter", "DejaVu Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; width: 1920px; height: 1080px; overflow: hidden;
  background: var(--bg); color: var(--fg); font-family: var(--font);
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
}
"""

LAYOUT_CSS = """
.bar { position: absolute; left: 0; top: 0; width: 1920px; height: 10px; background: var(--accent); }
.site { position: absolute; left: 80px; top: 1000px; font-size: 30px; color: var(--muted); letter-spacing: 0.01em; }
/* y 60..680 at full width; the note slot below stays left of the bubble. */
.content {
  position: absolute; left: 80px; top: 60px; width: 1760px; height: 620px;
  display: flex; flex-direction: column; overflow: hidden;
}
.note {
  position: absolute; left: 80px; top: 692px; width: 1400px; height: 64px; line-height: 64px;
  color: var(--hl); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.title {
  margin: 44px 0 0 0; font-weight: 800; line-height: 1.08; letter-spacing: -0.02em;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  max-width: 1640px; flex: none;
}
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; overflow: hidden; }
code {
  font-family: var(--mono); color: var(--hl); background: rgba(52, 211, 153, 0.10);
  padding: 0 0.22em; border-radius: 6px; font-size: 0.92em;
}
.clamp2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }

/* title */
.cover { justify-content: center; }
.cover .title { margin: 0; -webkit-line-clamp: 3; }
.cover .subtitle { margin-top: 36px; color: var(--hl); font-weight: 500; max-width: 1500px; }
.cover .rule { width: 120px; height: 8px; background: var(--accent); border-radius: 4px; margin-bottom: 44px; }

/* bullets */
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rows li { display: flex; align-items: baseline; gap: 28px; line-height: 1.25; }
.rows li .mark { font-family: var(--mono); color: var(--accent); font-weight: 700; flex: none; }
.rows li .txt { max-width: 1560px; }

/* compare */
.cols { display: flex; gap: 48px; align-items: stretch; }
.box {
  flex: 1; min-width: 0; border: 2px solid var(--accent); border-radius: 18px;
  padding: 36px 40px; background: rgba(139, 92, 246, 0.06); overflow: hidden;
}
.box h3 {
  margin: 0 0 22px 0; color: var(--accent); font-size: 34px; font-weight: 800;
  letter-spacing: 0.06em; text-transform: uppercase;
}
.box.right h3 { color: var(--hl); }
.box.right { border-color: var(--hl); background: rgba(52, 211, 153, 0.05); }
.box ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.box li { display: flex; gap: 20px; align-items: baseline; line-height: 1.25; }
.box li .mark { color: var(--muted); font-family: var(--mono); flex: none; }

/* flow */
.flow { display: flex; align-items: center; gap: 0; }
.step {
  flex: 1; min-width: 0; border: 2px solid var(--accent); border-radius: 18px;
  padding: 34px 26px; text-align: center; font-weight: 700; line-height: 1.2;
  background: rgba(139, 92, 246, 0.06); display: flex; align-items: center; justify-content: center;
  min-height: 200px;
}
.step:last-child { border-color: var(--hl); color: var(--hl); background: rgba(52, 211, 153, 0.06); }
.step .n { display: block; font-family: var(--mono); font-size: 24px; color: var(--muted); font-weight: 500; margin-bottom: 12px; }
.arrow { flex: none; width: 76px; display: flex; justify-content: center; }

/* statement */
.statement { justify-content: center; }
.statement blockquote {
  margin: 0; padding-left: 48px; border-left: 10px solid var(--accent);
  font-weight: 750; line-height: 1.15; letter-spacing: -0.015em; max-width: 1560px;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden;
}
.statement .attr { margin-top: 40px; padding-left: 58px; color: var(--muted); font-size: 36px; display: flex; align-items: center; gap: 18px; }
.statement .attr::before { content: ""; width: 40px; height: 3px; background: var(--hl); display: inline-block; }

/* code */
.codebox {
  position: relative; background: var(--panel); border: 1px solid rgba(139, 92, 246, 0.45);
  border-radius: 18px; padding: 40px 48px; overflow: hidden; max-width: 1500px;
}
.codebox pre { margin: 0; font-family: var(--mono); white-space: pre; line-height: 1.45; color: #E6E6F0; overflow: hidden; }
.codebox .lang {
  position: absolute; top: 16px; right: 22px; font-family: var(--mono); font-size: 22px;
  color: var(--muted); text-transform: lowercase;
}
"""

ARROW_SVG = (
    '<svg width="56" height="32" viewBox="0 0 56 32" xmlns="http://www.w3.org/2000/svg">'
    '<path d="M2 16 H46" stroke="#8B5CF6" stroke-width="4" stroke-linecap="round"/>'
    '<path d="M36 5 L50 16 L36 27" fill="none" stroke="#8B5CF6" stroke-width="4" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)

MAX_ROWS = 6
MAX_COMPARE_ROWS = 5
MAX_CODE_LINES = 12
LAYOUTS = ("title", "bullets", "compare", "flow", "statement", "code")


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def rich(text: str) -> str:
    """Escape, then let `backticks` mark inline code, the one markup allowed."""
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", esc(text))


def need_str(spec: dict, key: str, where: str) -> str:
    val = spec.get(key)
    if not isinstance(val, str) or not val.strip():
        raise SlideSpecError(f"{where}: '{key}' is required (non-empty string)")
    return " ".join(val.split())


def opt_str(spec: dict, key: str) -> str | None:
    val = spec.get(key)
    return " ".join(val.split()) if isinstance(val, str) and val.strip() else None


def str_list(spec: dict, key: str, where: str, lo: int, hi: int) -> list[str]:
    val = spec.get(key)
    if not isinstance(val, list):
        raise SlideSpecError(f"{where}: '{key}' must be a list of {lo}-{hi} strings")
    items = [" ".join(v.split()) for v in val if isinstance(v, str) and v.strip()]
    if not lo <= len(items) <= hi:
        raise SlideSpecError(f"{where}: '{key}' needs {lo}-{hi} non-empty strings, got {len(items)}")
    return items


def size_by_len(text: str, steps: list[tuple[int, int]], floor: int) -> int:
    for limit, px in steps:
        if len(text) <= limit:
            return px
    return floor


def title_px(title: str) -> int:
    return size_by_len(title, [(28, 88), (42, 78), (60, 66), (80, 58)], 50)


def note_html(note: str | None) -> str:
    if not note:
        return ""
    px = 36 if len(note) <= 70 else 30
    return f'<div class="note" style="font-size:{px}px">{rich(note)}</div>'


def rows_px(rows: list[str], count_base: int) -> int:
    longest = max(len(r) for r in rows)
    px = count_base
    if len(rows) >= 5:
        px -= 6
    if longest > 55:
        px -= 4
    if longest > 80:
        px -= 4
    return px


def title_block(title: str) -> str:
    return f'<h1 class="title" style="font-size:{title_px(title)}px">{rich(title)}</h1>'


def layout_title(spec: dict, where: str) -> str:
    title = need_str(spec, "title", where)
    subtitle = opt_str(spec, "subtitle")
    px = size_by_len(title, [(24, 120), (40, 104), (60, 88), (90, 74)], 62)
    sub = ""
    if subtitle:
        spx = 48 if len(subtitle) <= 60 else 40
        sub = f'<div class="subtitle clamp2" style="font-size:{spx}px">{rich(subtitle)}</div>'
    return (
        '<div class="content cover"><div class="rule"></div>'
        f'<h1 class="title" style="font-size:{px}px">{rich(title)}</h1>{sub}</div>'
    )


def layout_bullets(spec: dict, where: str) -> str:
    title = need_str(spec, "title", where)
    rows = str_list(spec, "rows", where, 1, MAX_ROWS)
    px = rows_px(rows, 48)
    gap = max(18, int(px * (0.9 if len(rows) <= 4 else 0.6)))
    items = "".join(
        f'<li><span class="mark">&gt;</span><span class="txt clamp2">{rich(r)}</span></li>' for r in rows
    )
    return (
        f'<div class="content">{title_block(title)}'
        f'<div class="body"><ul class="rows" style="font-size:{px}px;gap:{gap}px">{items}</ul></div></div>'
        f"{note_html(opt_str(spec, 'note'))}"
    )


def compare_side(spec: dict, side: str, where: str) -> tuple[str, list[str]]:
    raw = spec.get(side)
    if not isinstance(raw, dict):
        raise SlideSpecError(f"{where}: '{side}' must be an object with 'heading' and 'rows'")
    heading = need_str(raw, "heading", f"{where}.{side}")
    rows_raw = raw.get("rows", [])
    if rows_raw is None:
        rows_raw = []
    rows = str_list({"rows": rows_raw}, "rows", f"{where}.{side}", 0, MAX_COMPARE_ROWS)
    return heading, rows


def layout_compare(spec: dict, where: str) -> str:
    title = need_str(spec, "title", where)
    lh, lrows = compare_side(spec, "left", where)
    rh, rrows = compare_side(spec, "right", where)
    all_rows = lrows + rrows or [""]
    px = rows_px(all_rows, 40)
    count = max(len(lrows), len(rrows))
    gap = max(14, int(px * (0.6 if count <= 3 else 0.4)))

    def box(heading: str, rows: list[str], cls: str) -> str:
        items = "".join(
            f'<li><span class="mark">&ndash;</span><span class="clamp2">{rich(r)}</span></li>' for r in rows
        )
        ul = f'<ul style="font-size:{px}px;gap:{gap}px">{items}</ul>' if rows else ""
        return f'<div class="box {cls}"><h3>{rich(heading)}</h3>{ul}</div>'

    return (
        f'<div class="content">{title_block(title)}'
        f'<div class="body"><div class="cols">{box(lh, lrows, "left")}{box(rh, rrows, "right")}</div></div></div>'
        f"{note_html(opt_str(spec, 'note'))}"
    )


def layout_flow(spec: dict, where: str) -> str:
    title = need_str(spec, "title", where)
    steps = str_list(spec, "steps", where, 2, 5)
    longest = max(len(s) for s in steps)
    px = {2: 56, 3: 48, 4: 40, 5: 34}[len(steps)]
    if longest > 24:
        px -= 4
    if longest > 40:
        px -= 4
    parts = []
    for i, s in enumerate(steps):
        if i:
            parts.append(f'<div class="arrow">{ARROW_SVG}</div>')
        parts.append(
            f'<div class="step" style="font-size:{px}px"><div><span class="n">{i + 1:02d}</span>'
            f'<span class="clamp2" style="-webkit-line-clamp:3">{rich(s)}</span></div></div>'
        )
    return (
        f'<div class="content">{title_block(title)}'
        f'<div class="body"><div class="flow">{"".join(parts)}</div></div></div>'
        f"{note_html(opt_str(spec, 'note'))}"
    )


def layout_statement(spec: dict, where: str) -> str:
    text = need_str(spec, "text", where)
    attribution = opt_str(spec, "attribution")
    px = size_by_len(text, [(50, 100), (90, 84), (140, 70), (200, 60)], 52)
    attr = f'<div class="attr">{rich(attribution)}</div>' if attribution else ""
    return (
        '<div class="content statement">'
        f'<blockquote style="font-size:{px}px">{rich(text)}</blockquote>{attr}</div>'
    )


def layout_code(spec: dict, where: str) -> str:
    title = need_str(spec, "title", where)
    code = spec.get("code")
    if not isinstance(code, str) or not code.strip():
        raise SlideSpecError(f"{where}: 'code' is required (non-empty string)")
    lines = code.strip("\n").expandtabs(2).split("\n")
    if len(lines) > MAX_CODE_LINES:
        raise SlideSpecError(f"{where}: 'code' has {len(lines)} lines; the slide holds at most {MAX_CODE_LINES}")
    longest = max(len(line) for line in lines)
    px = 38 if len(lines) <= 6 else 32 if len(lines) <= 9 else 27
    # 1500px box minus padding; mono glyphs are ~0.6em wide.
    px = min(px, max(20, int(1400 / (max(longest, 1) * 0.61))))
    lang = opt_str(spec, "language")
    lang_html = f'<div class="lang">{esc(lang)}</div>' if lang else ""
    return (
        f'<div class="content">{title_block(title)}'
        f'<div class="body"><div class="codebox">{lang_html}'
        f'<pre style="font-size:{px}px">{esc(chr(10).join(lines))}</pre></div></div></div>'
        f"{note_html(opt_str(spec, 'note'))}"
    )


BUILDERS = {
    "title": layout_title,
    "bullets": layout_bullets,
    "compare": layout_compare,
    "flow": layout_flow,
    "statement": layout_statement,
    "code": layout_code,
}


def page(inner: str, css: str = "") -> str:
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        f"<style>{THEME_CSS}{css}</style></head><body>{inner}</body></html>"
    )


def build_html(spec: dict, site: str, index: int = 0) -> str:
    """The full page for one slide. Raises SlideSpecError on a malformed spec."""
    where = f"slide {index + 1}"
    if not isinstance(spec, dict):
        raise SlideSpecError(f"{where}: must be an object or null")
    if "html" in spec and "layout" not in spec:
        fragment = spec.get("html")
        if not isinstance(fragment, str) or not fragment.strip():
            raise SlideSpecError(f"{where}: 'html' must be a non-empty string")
        # The agent's own design: theme variables and fonts, nothing imposed.
        return page(
            '<div id="slide" style="position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:hidden">'
            f"{fragment}</div>"
        )
    layout = spec.get("layout")
    if layout is None:
        layout = "bullets"  # legacy {title, rows, note}
    if layout not in BUILDERS:
        raise SlideSpecError(f"{where}: unknown layout '{layout}' (use one of {', '.join(LAYOUTS)})")
    inner = BUILDERS[layout](spec, where)
    chrome = f'<div class="bar"></div>{inner}'
    if site:
        chrome += f'<div class="site">{esc(site)}</div>'
    return page(chrome, LAYOUT_CSS)


def render_slides(specs: list, site: str, out_dir: Path) -> list:
    """One PNG per non-null spec (slide{i}.png, i = block index); None for face-cam blocks."""
    from playwright.sync_api import sync_playwright

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Build every page first: a malformed spec fails before a browser starts.
    pages = [None if s is None else build_html(s, site, i) for i, s in enumerate(specs)]
    results: list = [None] * len(specs)
    if not any(p is not None for p in pages):
        return results

    def gate(route):
        url = route.request.url
        if url.startswith("data:") or url.startswith("about:"):
            route.continue_()
        else:
            route.abort()

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context(
                viewport={"width": WIDTH, "height": HEIGHT},
                device_scale_factor=1,
                java_script_enabled=False,
            )
            context.route("**/*", gate)
            for i, doc in enumerate(pages):
                if doc is None:
                    continue
                pg = context.new_page()
                try:
                    pg.set_default_timeout(TIMEOUT_MS)
                    pg.set_content(doc, wait_until="load", timeout=TIMEOUT_MS)
                    dest = out_dir / f"slide{i}.png"
                    pg.screenshot(path=str(dest), type="png", timeout=TIMEOUT_MS)
                    results[i] = dest
                finally:
                    pg.close()
            context.close()
        finally:
            browser.close()
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description="Render slide specs to 1920x1080 PNGs.")
    ap.add_argument("slides_json")
    ap.add_argument("out_dir")
    ap.add_argument("--site", default="agentwrotethis.dev")
    args = ap.parse_args()
    data = json.loads(Path(args.slides_json).read_text())
    specs = data.get("slides") if isinstance(data, dict) else data
    if not isinstance(specs, list):
        sys.exit("slides.json must be an array or {\"slides\": [...]}")
    for path in render_slides(specs, args.site, Path(args.out_dir)):
        if path is not None:
            print(path)


if __name__ == "__main__":
    main()
