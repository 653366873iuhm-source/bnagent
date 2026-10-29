"""Logo v3 'Woven chevron A' (concept r3-4), redrawn as clean vector geometry.
Gold upward chevron (Λ) woven with an amber V: gold left leg passes over the V, the V's right arm passes over the gold right leg.
Outputs into site/assets: bnagent-mark-v3.svg/.png, bnagent-lockup-v3.png, favicon-v3.svg, favicon-v3-32/180/512.png, og-v3.png,
logo-v3-preview.png."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'site', 'assets')
FONT = os.path.join(ROOT, 'r3', 'SpaceGrotesk.ttf')
GOLD = '#E8B84A'
AMBER = '#B07823'
CREAM = (244, 236, 220)
BG = (10, 10, 12)
GAP = 17

# --- geometry (units: original 510x462 trace space, baseline y=458) ---
gold_left = Polygon([(0, 458), (255, 5), (255, 140), (78, 458)])
gold_right = Polygon([(255, 5), (510, 458), (432, 458), (255, 140)])
amb_left = Polygon([(45, 140), (118, 140), (255, 345), (255, 458)])
amb_right = Polygon([(255, 345), (392, 140), (465, 140), (255, 458)])
gold_left = gold_left.buffer(0); gold_right = gold_right.buffer(0)
amber = unary_union([amb_left, amb_right]).difference(gold_left.buffer(GAP, join_style=2))
gold = unary_union([gold_left, gold_right]).difference(amb_right.buffer(GAP, join_style=2))
# trim slivers created by the gap cut
def clean(g):
    ps = [p for p in (g.geoms if isinstance(g, MultiPolygon) else [g]) if p.area > 50]
    return [Polygon([(round(x, 2), round(y, 2)) for x, y in p.exterior.coords]).simplify(0.01) for p in ps]
GOLD_P, AMBER_P = clean(gold), clean(amber)
ALL = GOLD_P + AMBER_P
minx = min(p.bounds[0] for p in ALL); miny = min(p.bounds[1] for p in ALL)
maxx = max(p.bounds[2] for p in ALL); maxy = max(p.bounds[3] for p in ALL)
W0, H0 = maxx - minx, maxy - miny

def path_d(p, s=1.0, ox=0.0, oy=0.0):
    pts = list(p.exterior.coords)[:-1]
    return 'M' + ' L'.join(f'{(x - minx) * s + ox:.2f} {(y - miny) * s + oy:.2f}' for x, y in pts) + ' Z'

def svg_mark(pad=0.0, bg=None, rx=0):
    S = max(W0, H0) + 2 * pad
    ox = (S - W0) / 2; oy = (S - H0) / 2
    body = ''
    if bg:
        body += f'<rect width="{S:.2f}" height="{S:.2f}" rx="{rx * S:.2f}" fill="{bg}"/>'
    body += ''.join(f'<path fill="{AMBER}" d="{path_d(p, 1, ox, oy)}"/>' for p in AMBER_P)
    body += ''.join(f'<path fill="{GOLD}" d="{path_d(p, 1, ox, oy)}"/>' for p in GOLD_P)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S:.2f} {S:.2f}">{body}</svg>\n'

def svg_mark_tight():
    body = ''.join(f'<path fill="{AMBER}" d="{path_d(p)}"/>' for p in AMBER_P)
    body += ''.join(f'<path fill="{GOLD}" d="{path_d(p)}"/>' for p in GOLD_P)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W0:.2f} {H0:.2f}">{body}</svg>\n'

def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def render_mark(height, ss=8):
    """Tight transparent RGBA of the mark, given pixel height, supersampled polygon fill."""
    s = height * ss / H0
    W, H = int(round(W0 * s)), int(round(H0 * s))
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for polys, col in ((AMBER_P, AMBER), (GOLD_P, GOLD)):
        for p in polys:
            d.polygon([((x - minx) * s, (y - miny) * s) for x, y in p.exterior.coords], fill=hexrgb(col) + (255,))
    return im.resize((max(1, round(W / ss)), height), Image.LANCZOS)

def font(size):
    f = ImageFont.truetype(FONT, size)
    try:
        axes = f.get_variation_axes()
        f.set_variation_by_axes([700 if a['name'] in (b'Weight', 'Weight') else a['default'] for a in axes])
    except Exception as e:
        print('font var fail', e)
    return f

def text_img(word, size, tracking, color):
    f = font(size)
    widths = [f.getlength(c) for c in word]
    W = int(sum(widths) + tracking * (len(word) - 1)) + 4
    asc, desc = f.getmetrics()
    im = Image.new('RGBA', (W, asc + desc), (0, 0, 0, 0))
    d = ImageDraw.Draw(im); x = 0
    for c, w in zip(word, widths):
        d.text((x, 0), c, font=f, fill=color + (255,)); x += w + tracking
    return im.crop(im.getbbox())

def lockup(mark_h, color=CREAM):
    m = render_mark(mark_h)
    cap = int(mark_h * 0.42)
    # pick font size so cap height == cap
    size = cap; t = text_img('BNAGENT', size, 0, color)
    size = int(size * cap / t.size[1]); t = text_img('BNAGENT', size, int(size * 0.09), color)
    gap = int(mark_h * 0.32)
    W = m.size[0] + gap + t.size[0]
    im = Image.new('RGBA', (W, mark_h), (0, 0, 0, 0))
    im.alpha_composite(m, (0, 0))
    # optical: center caps on mark's visual middle (slightly below center, mark is heavier at bottom)
    im.alpha_composite(t, (m.size[0] + gap, int((mark_h - t.size[1]) / 2 + mark_h * 0.04)))
    return im

def icon(size, pad=0.17, radius=0.22, bg=(22, 20, 18)):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle([0, 0, S - 1, S - 1], int(S * radius), fill=bg + (255,))
    m = render_mark(int(S * (1 - 2 * pad) * H0 / max(W0, H0)))
    im.alpha_composite(m, ((S - m.size[0]) // 2, (S - m.size[1]) // 2 + int(S * 0.01)))
    return im.resize((size, size), Image.LANCZOS)

def og():
    W, H = 1200, 630
    bg = Image.new('RGB', (W, H), BG)
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse([-100, -150, 800, 750], fill=46)
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    bg = Image.composite(Image.new('RGB', (W, H), (64, 46, 14)), bg, glow).convert('RGBA')
    lk = lockup(170)
    bg.alpha_composite(lk, ((W - lk.size[0]) // 2, 150))
    d = ImageDraw.Draw(bg)
    f1 = ImageFont.truetype(os.path.join(ROOT, 'r3', 'Inter.ttf'), 40)
    f2 = ImageFont.truetype(os.path.join(ROOT, 'r3', 'Inter.ttf'), 24)
    for f, txt, y, col in ((f1, 'Fair mint for .ai Agent IDs on BNB Smart Chain', 392, CREAM),
                           (f2, 'Independent · Not affiliated with Binance', 470, (160, 150, 132))):
        w = d.textlength(txt, font=f); d.text(((W - w) / 2, y), txt, font=f, fill=col)
    d.rectangle([0, H - 6, W, H], fill=hexrgb(GOLD))
    return bg.convert('RGB')

if __name__ == '__main__':
    open(os.path.join(OUT, 'bnagent-mark-v3.svg'), 'w').write(svg_mark_tight())
    open(os.path.join(OUT, 'favicon-v3.svg'), 'w').write(svg_mark(pad=W0 * 0.2, bg='#161412', rx=0.22))
    render_mark(512).save(os.path.join(OUT, 'bnagent-mark-v3.png'))
    lockup(108).save(os.path.join(OUT, 'bnagent-lockup-v3.png'))
    for s in (32, 180, 512):
        icon(s, pad=0.08 if s == 32 else 0.17).save(os.path.join(OUT, f'favicon-v3-{s}.png'))
    o = og(); o.save(os.path.join(OUT, 'og-v3.png'))
    # preview sheet
    P = Image.new('RGBA', (1600, 1060), BG + (255,))
    d = ImageDraw.Draw(P); lab = ImageFont.truetype(os.path.join(ROOT, 'r3', 'Inter.ttf'), 22)
    m = render_mark(300); P.alpha_composite(m, (80, 90)); d.text((80, 40), 'mark (vector)', font=lab, fill=(150, 140, 125))
    lk = lockup(108); P.alpha_composite(lk, (520, 120)); d.text((520, 40), 'lockup (header)', font=lab, fill=(150, 140, 125))
    lk2 = lockup(36); P.alpha_composite(lk2, (520, 290)); d.text((520, 250), 'lockup @ 36px', font=lab, fill=(150, 140, 125))
    x = 1080
    for s in (32, 180):
        ic = icon(s, pad=0.08 if s == 32 else 0.17); P.alpha_composite(ic, (x, 260 - s // 2 + 40)); d.text((x, 240 - 90), f'{s}', font=lab, fill=(150, 140, 125)); x += s + 60
    P.alpha_composite(o.convert('RGBA').resize((960, 504), Image.LANCZOS), (80, 500)); d.text((80, 460), 'og-v3.png', font=lab, fill=(150, 140, 125))
    ic = icon(512).resize((320, 320), Image.LANCZOS); P.alpha_composite(ic, (1160, 590)); d.text((1160, 550), 'favicon 512', font=lab, fill=(150, 140, 125))
    P.convert('RGB').save(os.path.join(OUT, 'logo-v3-preview.png'))
    print('ok', W0, H0, len(GOLD_P), len(AMBER_P))
