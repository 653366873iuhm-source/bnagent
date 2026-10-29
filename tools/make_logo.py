"""Generates the BNAGENT text logo (SVG) and favicon purely from code. No AI images."""
import math, os
out = os.path.join(os.path.dirname(__file__), "..", "site", "assets")
os.makedirs(out, exist_ok=True)
GOLD_A, GOLD_B, GOLD_C = "#F7E7A1", "#D4AF37", "#8C6A12"

def hexagon(cx, cy, r, rot=30):
    pts = []
    for i in range(6):
        a = math.radians(60 * i + rot)
        pts.append(f"{cx + r*math.cos(a):.2f},{cy + r*math.sin(a):.2f}")
    return " ".join(pts)

grad = f'''<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{GOLD_A}"/><stop offset=".5" stop-color="{GOLD_B}"/><stop offset="1" stop-color="{GOLD_C}"/></linearGradient></defs>'''

def mark(cx, cy, r):
    # outer hexagon ring + inner circuit-like "A" chevron + node dots
    s = f'<polygon points="{hexagon(cx,cy,r)}" fill="none" stroke="url(#g)" stroke-width="{r*0.12:.2f}" stroke-linejoin="round"/>'
    s += f'<polygon points="{hexagon(cx,cy,r*0.62)}" fill="url(#g)" opacity=".14"/>'
    w = r * 0.42
    s += (f'<path d="M{cx-w:.2f},{cy+w*0.9:.2f} L{cx:.2f},{cy-w*1.05:.2f} L{cx+w:.2f},{cy+w*0.9:.2f} '
          f'M{cx-w*0.5:.2f},{cy+w*0.25:.2f} L{cx+w*0.5:.2f},{cy+w*0.25:.2f}" fill="none" stroke="url(#g)" '
          f'stroke-width="{r*0.13:.2f}" stroke-linecap="round" stroke-linejoin="round"/>')
    for dx, dy in [(-w, w*0.9), (0, -w*1.05), (w, w*0.9)]:
        s += f'<circle cx="{cx+dx:.2f}" cy="{cy+dy:.2f}" r="{r*0.09:.2f}" fill="{GOLD_A}"/>'
    return s

logo = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 120" role="img" aria-label="BNAGENT">{grad}'
        f'{mark(60,60,46)}'
        f'<text x="122" y="78" font-family="\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif" font-size="56" '
        f'font-weight="800" letter-spacing="6" fill="url(#g)">BNAGENT</text></svg>')
open(os.path.join(out, "logo.svg"), "w").write(logo)
fav = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">{grad}<rect width="120" height="120" rx="24" fill="#0a0a0a"/>{mark(60,60,44)}</svg>'
open(os.path.join(out, "favicon.svg"), "w").write(fav)
print("wrote logo.svg, favicon.svg")
