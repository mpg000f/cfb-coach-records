"""Backfill pre-2013 spreads from Sportsbook Reviews Online archive pages.

SBR format: two rows per game (V=visitor/away, H=home). The Open/Close columns
hold the point spread on the favorite's row and the over/under on the underdog's
row; the smaller of the pair is the spread (spreads are always < totals). We
match each SBR game to a cached CFBD game by season + final scores (+ name check)
and emit a CFBD-/lines-shaped file so build.py can consume it uniformly.
"""
import json
import os
import re
import html
import glob

ROOT = os.path.dirname(__file__)
SBR = os.path.join(ROOT, "data", "raw_sbr")       # downloaded HTML (git-ignored cache)
RAW = os.path.join(ROOT, "data", "raw")           # CFBD cache (git-ignored)
SBR_OUT = os.path.join(ROOT, "data", "sbr")       # matched spreads (committed, build input)


def norm(name):
    """Loose team-name key: lowercase alnum, 'state'->'st', drop parentheticals."""
    s = html.unescape(name or "").lower()
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"[^a-z0-9]", "", s)
    s = s.replace("state", "st")
    return s


def parse_sbr(year):
    """Return list of games: {v, h, vf, hf, home_spread|None}."""
    path = os.path.join(SBR, f"sbr_{year}.html")
    doc = open(path, encoding="utf-8", errors="ignore").read()
    tbl = re.search(r"<table.*?</table>", doc, re.S | re.I).group(0)
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", tbl, re.S | re.I)
    parsed = []
    for r in rows:
        cells = [re.sub(r"<[^>]+>", "", c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S | re.I)]
        cells = [html.unescape(c).strip() for c in cells]
        if len(cells) >= 13 and cells[2] in ("V", "H", "N"):  # N = neutral site
            parsed.append(cells)

    def num(x):
        x = x.replace("½", ".5")
        if x.upper() in ("NL", "PK", "P", ""):
            return "PK" if x.upper() in ("PK", "P") else None
        try:
            return float(x)
        except ValueError:
            return None

    games = []
    i = 0
    while i < len(parsed) - 1:
        v = parsed[i]
        if v[2] not in ("V", "N"):               # first of pair (away, or neutral)
            i += 1
            continue
        h = parsed[i + 1]
        if h[2] not in ("H", "N"):               # second of pair (home, or neutral)
            i += 1
            continue
        i += 2
        vf, hf = num(v[8]), num(h[8])           # Final scores
        vc, hc = num(v[10]), num(h[10])          # Close line (spread or total)
        if vc == "PK" or hc == "PK":
            hs = 0.0
        elif isinstance(vc, float) and isinstance(hc, float):
            # smaller value = spread on the favorite
            hs = -min(vc, hc) if hc < vc else (min(vc, hc) if vc < hc else 0.0)
        else:
            hs = None
        games.append({"v": v[3], "h": h[3],
                      "vf": int(vf) if vf is not None else None,
                      "hf": int(hf) if hf is not None else None,
                      "home_spread": hs})
    return games


def cfbd_index(year):
    """(homePoints, awayPoints) -> list of cfbd games that season."""
    idx = {}
    for g in json.load(open(os.path.join(RAW, f"games_{year}.json"))):
        if g.get("homePoints") is None:
            continue
        idx.setdefault((g["homePoints"], g["awayPoints"]), []).append(g)
    return idx


def like(a, b):
    a, b = norm(a), norm(b)
    return a == b or (len(a) >= 4 and len(b) >= 4 and (a.startswith(b[:5]) or b.startswith(a[:5]) or a in b or b in a))


def match_year(year):
    idx = cfbd_index(year)
    out, matched, ambig, miss = [], 0, 0, 0
    for s in parse_sbr(year):
        if s["home_spread"] is None or s["hf"] is None:
            continue
        # Try both orientations; neutral-site games can have home/away flipped
        # between SBR and CFBD, which also flips the spread's sign.
        cand = [(g, False) for g in idx.get((s["hf"], s["vf"]), [])]
        if s["hf"] != s["vf"]:
            cand += [(g, True) for g in idx.get((s["vf"], s["hf"]), [])]
        pick, flip = None, False
        if len(cand) == 1:
            pick, flip = cand[0]                 # unique score match, no name needed
        elif len(cand) > 1:
            def ok(g, fl):
                hn, vn = (s["v"], s["h"]) if fl else (s["h"], s["v"])
                return like(g["homeTeam"], hn) and like(g["awayTeam"], vn)
            good = [(g, fl) for g, fl in cand if ok(g, fl)]
            if len(good) == 1:
                pick, flip = good[0]
        if pick:
            sp = -s["home_spread"] if flip else s["home_spread"]
            out.append({"id": pick["id"], "lines": [{"provider": "SBR", "spread": sp}]})
            matched += 1
        elif cand:
            ambig += 1
        else:
            miss += 1
    dest = os.path.join(SBR_OUT, f"lines_sbr_{year}.json")
    json.dump(out, open(dest, "w"))
    return matched, ambig, miss, len(out)


def main():
    os.makedirs(SBR_OUT, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(SBR, "sbr_*.html"))):
        year = int(re.search(r"sbr_(\d+)", f).group(1))
        m, a, ms, n = match_year(year)
        print(f"{year}: matched {m}, ambiguous {a}, unmatched {ms} -> wrote {n}")


if __name__ == "__main__":
    main()
