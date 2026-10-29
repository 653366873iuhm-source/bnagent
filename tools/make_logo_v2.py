from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
import shutil
OUT = "/workspace/work/bnagent/site/assets/"
D = "/workspace/work/logo2/"
BG = (7, 7, 7)
FONT = D + "Michroma-Regular.ttf.ttf"

# ---- mark: despill green fringe, tight crop
m = Image.open(D + "final_mark_t.png").convert("RGBA")
px = m.load()
for y in range(m.height):
    for x in range(m.width):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        lim = max(r, b) if r < 60 else int(r * 0.86)
        if g > lim:
            g = lim
        if a < 40:
            a = 0
        px[x, y] = (r, g, b, a)
m = m.crop(m.getbbox())
# upscale to 1200 tall, pad 4%
H = 1200
m = m.resize((round(m.width * H / m.height), H), Image.LANCZOS)
pad = 48
mark = Image.new("RGBA", (m.width + 2 * pad, m.height + 2 * pad), (0, 0, 0, 0))
mark.alpha_composite(m, (pad, pad))
mark.save(OUT + "bnagent-mark-v2.png", optimize=True)
tight = m


def gold_fill(size):
    w, h = size
    g = Image.new("RGB", (1, h))
    stops = [(0, (255, 244, 200)), (0.42, (236, 201, 110)), (0.6, (214, 171, 72)), (1, (150, 108, 30))]
    for y in range(h):
        t = y / max(h - 1, 1)
        for i in range(len(stops) - 1):
            a, ca = stops[i]; b, cb = stops[i + 1]
            if a <= t <= b:
                k = (t - a) / (b - a)
                g.putpixel((0, y), tuple(round(ca[j] + (cb[j] - ca[j]) * k) for j in range(3)))
                break
    return g.resize((w, h))


def text_img(txt, cap, tracking=0.22, fill=None):
    f = ImageFont.truetype(FONT, int(cap * 1.38))
    asc = f.getbbox("H")
    ch = asc[3] - asc[1]
    f = ImageFont.truetype(FONT, int(f.size * cap / ch))
    widths = [f.getlength(c) for c in txt]
    tr = cap * tracking
    W = int(sum(widths) + tr * (len(txt) - 1)) + 4
    bb = f.getbbox("H")
    Hh = bb[3] - bb[1]
    mask = Image.new("L", (W, Hh + 4))
    d = ImageDraw.Draw(mask)
    x = 0
    for c, w in zip(txt, widths):
        d.text((x, -bb[1] + 2), c, font=f, fill=255)
        x += w + tr
    mask = mask.crop(mask.getbbox())
    col = gold_fill(mask.size) if fill is None else Image.new("RGB", mask.size, fill)
    im = col.convert("RGBA"); im.putalpha(mask)
    return im


def lockup(mark_h):
    mk = tight.resize((round(tight.width * mark_h / tight.height), mark_h), Image.LANCZOS)
    t = text_img("BNAGENT", int(mark_h * 0.36))
    gap = int(mark_h * 0.30)
    W = mk.width + gap + t.width
    im = Image.new("RGBA", (W, mark_h), (0, 0, 0, 0))
    im.alpha_composite(mk, (0, 0))
    im.alpha_composite(t, (mk.width + gap, (mark_h - t.height) // 2))
    return im

lk = lockup(320)
lk.save(OUT + "bnagent-lockup-v2.png", optimize=True)


def icon(n, scale=0.80):
    im = Image.new("RGBA", (n, n), BG + (255,))
    h = round(n * scale)
    mk = tight.resize((round(tight.width * h / tight.height), h), Image.LANCZOS)
    if n <= 64:
        mk = mk.filter(ImageFilter.UnsharpMask(1, 120, 2))
    im.alpha_composite(mk, ((n - mk.width) // 2, (n - h) // 2))
    return im.convert("RGB")

icon(32, 0.88).save(OUT + "favicon-v2-32.png")
icon(180).save(OUT + "favicon-v2-180.png")
icon(512).save(OUT + "favicon-v2-512.png")


def glow_bg(w, h, cx, cy, rad, strength=70):
    bg = Image.new("RGB", (w, h), BG)
    gl = Image.new("L", (w, h), 0)
    ImageDraw.Draw(gl).ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=strength)
    gl = gl.filter(ImageFilter.GaussianBlur(rad * 0.6))
    gold = Image.new("RGB", (w, h), (120, 88, 20))
    return Image.composite(gold, bg, gl).convert("RGBA")

# ---- og 1200x630
og = glow_bg(1200, 630, 270, 315, 250, 90)
mk = tight.resize((round(tight.width * 380 / tight.height), 380), Image.LANCZOS)
og.alpha_composite(mk, (270 - mk.width // 2, 125))
t = text_img("BNAGENT", 52)
X = 520
og.alpha_composite(t, (X, 228))
d = ImageDraw.Draw(og)
d.line((X, 305, X + t.width, 305), fill=(201, 162, 58, 255), width=2)
s1 = text_img("FAIR MINT FOR .AI AGENT IDS", 17, 0.12, (236, 220, 180))
og.alpha_composite(s1, (X, 326))
s2 = text_img("ON BNB SMART CHAIN", 17, 0.12, (236, 220, 180))
og.alpha_composite(s2, (X, 357))
small = ImageFont.truetype(D + "Montserrat.ttf", 17)
small.set_variation_by_axes([500])
d.text((X, 415), "Independent community project · Not affiliated with Binance", font=small, fill=(165, 152, 125, 255))
print("og text right edge", X + t.width, X + s1.width)
og.convert("RGB").save(OUT + "og-v2.png", optimize=True)

# ---- preview
P = glow_bg(1600, 1000, 400, 430, 300, 80)
mk = tight.resize((round(tight.width * 560 / tight.height), 560), Image.LANCZOS)
P.alpha_composite(mk, (400 - mk.width // 2, 150))
lk2 = lockup(150)
P.alpha_composite(lk2, (760, 330))
x = 760
for n in (180, 64, 32):
    ic = icon(n if n != 64 else 180).resize((n, n), Image.LANCZOS) if n == 64 else Image.open(OUT + f"favicon-v2-{n}.png")
    P.alpha_composite(ic.convert("RGBA"), (x, 560))
    x += n + 30
ogs = Image.open(OUT + "og-v2.png").resize((440, 231), Image.LANCZOS).convert("RGBA")
P.alpha_composite(ogs, (x + 10, 560))
d = ImageDraw.Draw(P)
d.rectangle((x + 10, 560, x + 450, 791), outline=(60, 50, 30, 255))
lbl = ImageFont.truetype(D + "Montserrat.ttf", 20)
d.text((760, 820), "favicons 180 / 64 / 32  ·  og image", font=lbl, fill=(120, 110, 90, 255))
P.convert("RGB").save(OUT + "logo-v2-preview.png", optimize=True)

for i, f in enumerate(["c2_monogramB.png", "c1_agenthead.png", "c3_neuralorb.png"], 1):
    shutil.copy(D + f, OUT + f"logo-v2-alt-{i}.png")
print("done", lk.size, mark.size)
