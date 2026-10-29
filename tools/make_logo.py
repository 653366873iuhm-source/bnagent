"""BNAGENT brand assets, generated from code (no AI images, no Binance artwork).

Mark: a faceted gold hexagonal gem (six facets lit from the top-left) inside a fine hexagon frame, with a
dark negative-space chevron "A" (agent / apex) and a small node. Wordmark: Montserrat SemiBold (OFL) glyphs
converted to SVG paths, so it renders identically everywhere. Palette = site palette (#070707 / gold).

Outputs (site/assets): mark.svg, logo.svg (mark + wordmark), favicon.svg, og.svg + PNG renders are made by
tools/render_assets.js (favicon-32/180/512.png, og.png, logo-preview.png).
"""
import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "assets")
os.makedirs(OUT, exist_ok=True)

BG = "#070707"
G1, G2, G3, G4 = "#FBF0C0", "#E9CB6B", "#C9A23A", "#7A5A12"


def hexpts(cx, cy, r, rot=-90):
    return [(cx + r * math.cos(math.radians(rot + 60 * i)), cy + r * math.sin(math.radians(rot + 60 * i))) for i in range(6)]


def P(pts):
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)


def defs(uid):
    return f"""<defs>
<linearGradient id="{uid}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{G1}"/><stop offset=".45" stop-color="{G2}"/><stop offset="1" stop-color="{G4}"/></linearGradient>
<linearGradient id="{uid}w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{G1}"/><stop offset=".55" stop-color="{G2}"/><stop offset="1" stop-color="{G3}"/></linearGradient>
</defs>"""


def mark(uid, cx=50, cy=50, s=1.0, frame=True, bold=1.0):
    """Mark drawn in a 100x100 box (scaled by s around cx, cy)."""
    R_frame, R_gem = 47 * s, 40 * s
    out = []
    if frame:
        out.append(f'<polygon points="{P(hexpts(cx, cy, R_frame))}" fill="none" stroke="url(#{uid}g)" stroke-width="{1.6*s:.2f}" stroke-linejoin="round" opacity=".9"/>')
    v = hexpts(cx, cy, R_gem)
    # facet tones, vertex order from top going clockwise: top-right, right, bottom-right, bottom-left, left, top-left
    tones = ["#F3DD8E", "#D9B44E", "#9C7623", "#B88E30", "#E6C766", "#FFF3C4"]
    for i in range(6):
        a, b = v[i], v[(i + 1) % 6]
        out.append(f'<polygon points="{P([(cx, cy), a, b])}" fill="{tones[i]}"/>')
    # subtle inner rim
    out.append(f'<polygon points="{P(v)}" fill="none" stroke="#FFF7D6" stroke-opacity=".35" stroke-width="{0.6*s:.2f}" stroke-linejoin="round"/>')
    # negative-space chevron "A" cut clean through the gem (clipped to the gem) + node
    w = 5.0 * s * bold
    apex = (cx, cy - 21 * s)
    dx, dy = 0.46, 1.0  # leg direction (narrow, elegant A)
    L = 60 * s
    l, r = (apex[0] - dx * L, apex[1] + dy * L), (apex[0] + dx * L, apex[1] + dy * L)
    out.append(f'<clipPath id="{uid}c"><polygon points="{P(v)}"/></clipPath>')
    out.append(f'<path clip-path="url(#{uid}c)" d="M{l[0]:.2f},{l[1]:.2f} L{apex[0]:.2f},{apex[1]:.2f} L{r[0]:.2f},{r[1]:.2f}" fill="none" stroke="{BG}" stroke-width="{w:.2f}" stroke-linejoin="miter" stroke-miterlimit="10"/>')
    out.append(f'<circle cx="{cx:.2f}" cy="{cy + 9*s:.2f}" r="{3.3*s:.2f}" fill="{BG}"/>')
    return "\n".join(out)


def wordmark(text, font_path, x, baseline, cap_h, tracking_em=0.12):
    """Glyph outlines as one SVG path; returns (path_d, width)."""
    f = TTFont(font_path)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    cap = f["OS/2"].sCapHeight or f["head"].unitsPerEm * 0.7
    k = cap_h / cap
    pen = SVGPathPen(gs)
    cur = 0.0
    upm = f["head"].unitsPerEm
    hmtx = f["hmtx"]
    for i, ch in enumerate(text):
        gname = cmap[ord(ch)]
        tp = TransformPen(pen, (k, 0, 0, -k, x + cur, baseline))
        gs[gname].draw(tp)
        cur += hmtx[gname][0] * k
        if i < len(text) - 1:
            cur += tracking_em * upm * k
    return pen.getCommands(), cur


FONT = os.path.join(HERE, "fonts", "mont600.ttf")


def write(name, svg):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(svg)


# --- mark only
write("mark.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="BNAGENT">{defs("m")}{mark("m")}</svg>')

# --- favicon (no frame, gem fills the tile on a dark rounded square for legibility at 16-32px)
write("favicon.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{defs("f")}<rect width="100" height="100" rx="22" fill="{BG}"/>{mark("f", 50, 51, 1.18, frame=False, bold=1.45)}</svg>')

# --- horizontal logo: mark + wordmark
H = 100
d, w = wordmark("BNAGENT", FONT, 0, 0, 34, 0.14)
wx = 122
logo_w = int(wx + w + 6)
d2, _ = wordmark("BNAGENT", FONT, wx, 67, 34, 0.14)
write("logo.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {logo_w} {H}" role="img" aria-label="BNAGENT">{defs("l")}{mark("l", 50, 50, 1.0)}<path d="{d2}" fill="url(#lw)"/></svg>')

# --- OG image 1200x630
ow, oh = 1200, 630
dt, tw = wordmark("BNAGENT", FONT, 0, 0, 78, 0.16)
tx = (ow - tw) / 2 + 0
dt2, _ = wordmark("BNAGENT", FONT, tx, 412, 78, 0.16)
sub = "FAIR MINT FOR .AI AGENT IDS  ·  BNB SMART CHAIN"
ds, sw = wordmark(sub, os.path.join(HERE, "fonts", "mont500.ttf"), 0, 0, 17, 0.22)
ds2, _ = wordmark(sub, os.path.join(HERE, "fonts", "mont500.ttf"), (ow - sw) / 2, 470, 17, 0.22)
note = "Independent community project. Not affiliated with Binance."
dn, nw = wordmark(note, os.path.join(HERE, "fonts", "mont500.ttf"), 0, 0, 12, 0.06)
dn2, _ = wordmark(note, os.path.join(HERE, "fonts", "mont500.ttf"), (ow - nw) / 2, 590, 12, 0.06)
og = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {ow} {oh}">{defs("o")}
<defs><radialGradient id="ob" cx=".5" cy=".28" r=".75"><stop offset="0" stop-color="#2a210c"/><stop offset=".55" stop-color="#0d0b07"/><stop offset="1" stop-color="{BG}"/></radialGradient></defs>
<rect width="{ow}" height="{oh}" fill="url(#ob)"/>
<rect x="24" y="24" width="{ow-48}" height="{oh-48}" rx="18" fill="none" stroke="#d4af37" stroke-opacity=".22"/>
<g>{mark("o", 600, 205, 2.05)}</g>
<path d="{dt2}" fill="url(#ow)"/>
<rect x="{ow/2-60}" y="436" width="120" height="1.5" fill="#d4af37" opacity=".55"/>
<path d="{ds2}" fill="#cbbf9c"/>
<path d="{dn2}" fill="#8a816d"/>
</svg>'''
write("og.svg", og)
print("logo width", logo_w)
