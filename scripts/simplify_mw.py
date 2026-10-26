#!/usr/bin/env python3
"""Simplify d3-celestial's mw.json (Milky Way outline, BSD-3) for faster rendering.

Ramer-Douglas-Peucker per ring; drops rings that collapse. Writes public/data/mw.simplified.json.
Usage: python3 scripts/simplify_mw.py [--tol 0.2]
"""
import argparse, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "data", "mw.json")
OUT = os.path.join(ROOT, "public", "data", "mw.simplified.json")


def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, bi = d2, i
        if best > tol * tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--tol", type=float, default=0.2)
    tol = ap.parse_args().tol
    d = json.load(open(SRC))
    before = after = 0
    for f in d["features"]:
        polys = []
        for poly in f["geometry"]["coordinates"]:
            rings = []
            for ring in poly:
                before += len(ring)
                r = rdp(ring, tol)
                if len(r) >= 4:
                    if r[0] != r[-1]:
                        r.append(r[0])
                    rings.append([[round(x, 2), round(y, 2)] for x, y in r])
                    after += len(rings[-1])
            if rings:
                polys.append(rings)
        f["geometry"]["coordinates"] = polys
    json.dump(d, open(OUT, "w"), separators=(",", ":"))
    print(f"points {before} -> {after}; wrote {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT)//1024} KB)")


if __name__ == "__main__":
    main()
