"""Generate a pre-rendered, crawlable page per coach at web/c/<slug>.html.

Each page carries coach-specific <title>/description/OG tags and a static summary
(so search engines and link-unfurlers see real content), then hydrates into the
full app on load. Also writes sitemap.xml and robots.txt. Run after export_web.py.
Idempotent; output is git-ignored and produced at deploy time.
"""
import os
import re
import html
import sqlite3

ROOT = os.path.dirname(__file__)
WEB = os.path.join(ROOT, "web")
DB = os.path.join(WEB, "data", "coaches.db")
OUT = os.path.join(WEB, "c")
SITE = "https://mpg000f.github.io/cfb-coach-records"


def slugify(name):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def esc(s):
    return html.escape(str(s), quote=True)


def rk(n):
    return f'<span class="rk">#{n}</span>' if n else "—"


def spr(s):
    if s is None:
        return "—"
    if s == 0:
        return "PK"
    return f'<span class="{"fav" if s < 0 else "dog"}">{s if s < 0 else "+" + str(s)}</span>'


def build_template():
    """index.html transformed for a /c/ subdirectory: fix asset paths, strip the
    homepage's SEO/OG block (coach_page injects a coach-specific one)."""
    t = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
    t = t.replace('href="styles.css"', 'href="../styles.css"')
    t = t.replace('src="vendor/sql-wasm.js"', 'src="../vendor/sql-wasm.js"')
    t = t.replace('src="app.js"', 'src="../app.js"')
    # Remove the site-level description + canonical + OG/twitter block, keep <title>.
    t = re.sub(r'<meta name="description".*?<meta name="twitter:card"[^>]*>\s*', "", t, count=1, flags=re.S)
    return t


def coach_page(t, con, coach):
    slug = slugify(coach)
    span = con.execute("SELECT first_year, last_year, games FROM coaches WHERE coach=?", (coach,)).fetchone()
    fy, ly, _ = span
    # Headline record matches the app's defaults: vs AP Top 10 at kickoff, 2000–2025.
    w, l = con.execute("""SELECT SUM(result='W'), SUM(result='L') FROM games
        WHERE coach=? AND opp_ap_game BETWEEN 1 AND 10 AND season BETWEEN 2000 AND 2025""", (coach,)).fetchone()
    w, l = w or 0, l or 0
    pct = f"{w / (w + l) * 100:.1f}%" if (w + l) else "—"
    schools = con.execute("""SELECT team, MIN(season), MAX(season) FROM games
        WHERE coach=? GROUP BY team ORDER BY MIN(season)""", (coach,)).fetchall()
    chips = " ".join(f'<span class="chip">{esc(tm)} <em>{a if a == b else f"{a}–{b}"}</em></span>' for tm, a, b in schools)

    games = con.execute("""SELECT season, team, opponent, opp_coach, spread, team_pts, opp_pts,
        result, neutral, home, team_ap_game, opp_ap_game FROM games
        WHERE coach=? AND opp_ap_game BETWEEN 1 AND 10 AND season BETWEEN 2000 AND 2025
        ORDER BY season, week""", (coach,)).fetchall()
    trs = []
    for s, tm, opp, oc, sp, tp, op, res, neu, home, tr, orr in games:
        loc = "vs" if (neu or home) else "at"
        site = ' <span class="hint">(N)</span>' if neu else ""
        trs.append(f'<tr><td class="num">{s}</td><td>{esc(tm)}</td>'
                   f'<td>{loc} {esc(opp)}{site}</td><td>{esc(oc) if oc else "—"}</td>'
                   f'<td class="num">{rk(orr)}</td><td class="num">{rk(tr)}</td>'
                   f'<td class="num">{spr(sp)}</td><td class="num">{tp}–{op}</td>'
                   f'<td class="res {res}">{res}</td></tr>')
    table = (f'<div class="table-scroll"><table><thead><tr><th>Season</th><th>Team</th>'
             f'<th>Opponent</th><th>Opp. coach</th><th>Opp rank</th><th>Team rank</th>'
             f'<th>Line</th><th>Score</th><th>Res</th></tr></thead><tbody>{"".join(trs)}</tbody></table></div>'
             ) if trs else '<p class="empty">No games vs AP Top 10 in 2000–2025.</p>'

    schools_names = ", ".join(tm for tm, _, _ in schools)
    title = f"{coach} — record vs ranked teams | Coach vs. Ranked"
    desc = (f"{coach} ({fy}–{ly}, {schools_names}) is {w}–{l} vs AP Top 10 teams "
            f"(2000–2025). Full game log with ranks, pregame spreads, and head-to-head splits.")
    url = f"{SITE}/c/{slug}.html"

    head = (f'<title>{esc(title)}</title>\n'
            f'<meta name="description" content="{esc(desc)}">\n'
            f'<link rel="canonical" href="{url}">\n'
            f'<meta property="og:type" content="profile">\n'
            f'<meta property="og:site_name" content="Coach vs. Ranked">\n'
            f'<meta property="og:title" content="{esc(coach)} vs. ranked teams">\n'
            f'<meta property="og:description" content="{esc(desc)}">\n'
            f'<meta property="og:url" content="{url}">\n'
            f'<meta name="twitter:card" content="summary">')

    prerender = (f'<div class="detail-head"><a class="back" href="../">← All coaches</a>'
                 f'<h2 class="coach-title">{esc(coach)}</h2><div class="schools">{chips}</div>'
                 f'<p class="sub">vs Top 10 (AP, at kickoff) · {fy}–{ly}</p></div>'
                 f'<div class="summary" style="display:grid">'
                 f'<div class="stat"><div class="v">{w}–{l}</div><div class="k">Record</div></div>'
                 f'<div class="stat"><div class="v">{pct}</div><div class="k">Win %</div></div>'
                 f'<div class="stat"><div class="v">{len(games)}</div><div class="k">Games</div></div>'
                 f'<div class="stat"><div class="v">{fy}–{ly}</div><div class="k">Span</div></div></div>'
                 f'{table}')

    page = t
    page = re.sub(r"<title>.*?</title>", head, page, count=1, flags=re.S)
    page = page.replace('<input id="coach-input" type="text" autocomplete="off" spellcheck="false"',
                        f'<input id="coach-input" type="text" autocomplete="off" spellcheck="false" value="{esc(coach)}"')
    page = page.replace('<section id="results"></section>', f'<section id="results">{prerender}</section>')
    return slug, page


def main():
    os.makedirs(OUT, exist_ok=True)
    con = sqlite3.connect(DB)
    t = build_template()
    coaches = [r[0] for r in con.execute("SELECT coach FROM coaches")]
    urls = [f"{SITE}/"]
    for coach in coaches:
        slug, page = coach_page(t, con, coach)
        open(os.path.join(OUT, f"{slug}.html"), "w", encoding="utf-8").write(page)
        urls.append(f"{SITE}/c/{slug}.html")
    con.close()

    sm = ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
          + "".join(f"<url><loc>{u}</loc></url>\n" for u in urls) + "</urlset>\n")
    open(os.path.join(WEB, "sitemap.xml"), "w").write(sm)
    open(os.path.join(WEB, "robots.txt"), "w").write(
        f"User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n")
    print(f"generated {len(coaches)} coach pages + sitemap ({len(urls)} urls)")


if __name__ == "__main__":
    main()
