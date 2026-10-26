#!/usr/bin/env python3
"""Build public/data/stars.json from the HYG star database (v4.1, CC BY-SA 4.0).

Source: https://github.com/astronexus/HYG-Database (hyg/CURRENT/hygdata_v41.csv)
Keeps stars with apparent magnitude <= MAG_LIMIT (naked-eye), excluding the Sun.

Usage: python3 scripts/build_stars.py [--mag 6.5]
"""
import argparse, csv, json, os, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data_raw", "hygdata_v41.csv")
URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv"
OUT = os.path.join(ROOT, "public", "data", "stars.json")
PC_TO_LY = 3.261563777

GREEK = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ", "Eps": "ε", "Zet": "ζ", "Eta": "η",
    "The": "θ", "Iot": "ι", "Kap": "κ", "Lam": "λ", "Mu": "μ", "Nu": "ν", "Xi": "ξ",
    "Omi": "ο", "Pi": "π", "Rho": "ρ", "Sig": "σ", "Tau": "τ", "Ups": "υ", "Phi": "φ",
    "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}


def bayer_name(bayer, con):
    # HYG bayer looks like "Alp", "Alp-1", "Pi-3"
    base, _, comp = bayer.partition("-")
    g = GREEK.get(base, base)
    sup = {"1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶"}.get(comp, comp)
    return f"{g}{sup} {con}".strip()


def make_name(r):
    if r["proper"]:
        return r["proper"]
    if r["bayer"] and r["con"]:
        return bayer_name(r["bayer"], r["con"])
    if r["flam"] and r["con"]:
        return f"{r['flam']} {r['con']}"
    if r["hip"]:
        return f"HIP {r['hip']}"
    if r["hd"]:
        return f"HD {r['hd']}"
    if r["gl"]:
        return r["gl"]
    return f"HYG {r['id']}"


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mag", type=float, default=6.5)
    args = ap.parse_args()

    if not os.path.exists(RAW):
        os.makedirs(os.path.dirname(RAW), exist_ok=True)
        print("downloading", URL)
        urllib.request.urlretrieve(URL, RAW)

    stars = []
    with open(RAW, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["id"] == "0" or r["proper"] == "Sol":
                continue
            mag = fnum(r["mag"])
            if mag is None or mag > args.mag:
                continue
            dist = fnum(r["dist"])
            # HYG uses 100000 pc as "unknown distance"
            dist_ly = round(dist * PC_TO_LY, 1) if dist and dist < 100000 else None
            ci = fnum(r["ci"])
            stars.append({
                "id": int(r["id"]),
                "name": make_name(r),
                "proper": r["proper"] or None,
                "hip": int(r["hip"]) if r["hip"] else None,
                "ra": round(float(r["ra"]) * 15.0, 4),   # hours -> degrees
                "dec": round(float(r["dec"]), 4),
                "mag": round(mag, 2),
                "dist_ly": dist_ly,
                "spect": r["spect"] or None,
                "con": r["con"] or None,
                "ci": round(ci, 3) if ci is not None else None,
            })
    stars.sort(key=lambda s: s["mag"])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(stars, f, ensure_ascii=False, separators=(",", ":"))
    named = sum(1 for s in stars if s["proper"])
    print(f"wrote {len(stars)} stars ({named} with proper names) to {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
