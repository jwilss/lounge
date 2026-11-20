# Builds the Lounge pointer theme (system/cursors/Lounge). Needs python3-cairo and xcursorgen (x11-apps).
# Usage: python3 tools/make-cursors.py system/cursors/Lounge
import cairo, math, os, shutil, subprocess, sys
OUT = sys.argv[1]
SIZES = [24, 32, 48, 64, 88, 96, 128]
os.makedirs(f"{OUT}/cursors", exist_ok=True)
ACCENT = (1.0, 0.62, 0.04)

def arrow_path(cr, s):
    # classic arrow, tip at (0,0), in units of s
    pts = [(0,0),(0,0.78),(0.2,0.6),(0.33,0.9),(0.45,0.85),(0.32,0.56),(0.58,0.56)]
    cr.move_to(*[p*s for p in pts[0]])
    for x,y in pts[1:]:
        cr.line_to(x*s, y*s)
    cr.close_path()

def draw(kind, size):
    pad = max(2, round(size*0.12))
    S = size
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, S, S)
    cr = cairo.Context(surf)
    cr.set_line_join(cairo.LINE_JOIN_ROUND); cr.set_line_cap(cairo.LINE_CAP_ROUND)
    lw = max(1.5, size*0.06)
    if kind in ("arrow", "link", "wait"):
        s = size*0.82
        ox, oy = pad*0.6 + lw*0.7, pad*0.5 + lw*0.7
        # soft shadow
        for i,a in ((3,0.08),(2,0.12),(1,0.18)):
            cr.save(); cr.translate(ox+size*0.03*i/2, oy+size*0.05*i/2); arrow_path(cr, s)
            cr.set_source_rgba(0,0,0,a); cr.set_line_width(lw*2.2); cr.stroke_preserve(); cr.fill(); cr.restore()
        cr.save(); cr.translate(ox, oy); arrow_path(cr, s)
        cr.set_source_rgb(1,1,1); cr.fill_preserve()
        cr.set_source_rgb(0.05,0.05,0.07); cr.set_line_width(lw); cr.stroke(); cr.restore()
        hot = (round(ox), round(oy))
        if kind == "link":   # orange dot: "you can click this"
            r = size*0.15; cx, cy = size-r-pad*0.3, size-r-pad*0.3
            cr.arc(cx, cy, r+lw*0.6, 0, 2*math.pi); cr.set_source_rgb(0.05,0.05,0.07); cr.fill()
            cr.arc(cx, cy, r, 0, 2*math.pi); cr.set_source_rgb(*ACCENT); cr.fill()
        if kind == "wait":
            r = size*0.15; cx, cy = size-r-pad*0.4, size-r-pad*0.4
            cr.arc(cx, cy, r, 0, 2*math.pi); cr.set_source_rgb(0.05,0.05,0.07); cr.set_line_width(lw*2.4); cr.stroke()
            cr.arc(cx, cy, r, -math.pi/2, math.pi*0.9); cr.set_source_rgb(*ACCENT); cr.set_line_width(lw*1.3); cr.stroke()
        return surf, hot
    if kind == "text":
        cx = size/2; top, bot = size*0.12, size*0.88; w = size*0.16
        def ibeam():
            cr.move_to(cx-w, top); cr.line_to(cx+w, top)
            cr.move_to(cx, top); cr.line_to(cx, bot)
            cr.move_to(cx-w, bot); cr.line_to(cx+w, bot)
        ibeam(); cr.set_source_rgb(0.05,0.05,0.07); cr.set_line_width(lw*3.2); cr.stroke()
        ibeam(); cr.set_source_rgb(1,1,1); cr.set_line_width(lw*1.4); cr.stroke()
        return surf, (round(cx), round(size/2))

NAMES = {
    "arrow": ["default", "left_ptr", "arrow", "top_left_arrow", "grab", "grabbing", "move", "fleur", "all-scroll",
              "context-menu", "help", "copy", "alias", "dnd-move", "dnd-copy"],
    "link": ["pointer", "hand", "hand1", "hand2", "pointing_hand", "e29285e634086352946a0e7090d73106",
             "9d800788f1b08800ae810202380a0822"],
    "text": ["text", "xterm", "ibeam", "vertical-text"],
    "wait": ["wait", "watch", "progress", "left_ptr_watch", "half-busy",
             "08e8e1c95fe2fc01f976f1e063a24ccd", "3ecb610c1bf2410f44200f48c40d3599"],
}
os.makedirs(os.path.join(os.path.dirname(OUT), "_png"), exist_ok=True)
for kind, names in NAMES.items():
    cfg = []
    for sz in SIZES:
        surf, (hx, hy) = draw(kind, sz)
        p = f"{os.path.dirname(OUT)}/_png/{kind}-{sz}.png"; surf.write_to_png(p)
        cfg.append(f"{sz} {hx} {hy} {p}")
    open(f"{os.path.dirname(OUT)}/_png/{kind}.cfg", "w").write("\n".join(cfg) + "\n")
    subprocess.run(["xcursorgen", f"{os.path.dirname(OUT)}/_png/{kind}.cfg", f"{OUT}/cursors/{names[0]}"], check=True)
    for n in names[1:]:
        dst = f"{OUT}/cursors/{n}"
        if os.path.lexists(dst): os.remove(dst)
        shutil.copyfile(f"{OUT}/cursors/{names[0]}", dst)  # copies, not links: survives Windows and zips
open(f"{OUT}/index.theme", "w").write("[Icon Theme]\nName=Lounge\nComment=Big, high-contrast pointer for Lounge\nInherits=Adwaita\n")

import shutil
shutil.rmtree(os.path.join(os.path.dirname(OUT), "_png"), ignore_errors=True)
