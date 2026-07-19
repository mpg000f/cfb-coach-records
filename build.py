"""Join games + weekly polls + coach tenures into a SQLite game-level table.

One row per (coach, game). Each row carries the coach's team rank and the
opponent rank both AT KICKOFF (that week's poll) and FINAL (postseason poll),
for AP and Coaches polls, so any rank/matchup filter is a plain WHERE clause.
"""
import json
import os
import glob
import sqlite3
from collections import defaultdict

ROOT = os.path.dirname(__file__)
RAW = os.path.join(ROOT, "data", "raw")
DB = os.path.join(ROOT, "data", "coach_ranked.db")

POLLS = {"AP Top 25": "ap", "Coaches Poll": "coaches"}


def load(name):
    return json.load(open(os.path.join(RAW, name)))


def load_overrides():
    """Return (corrections-by-year, coach-boundaries-by-key) from overrides.json."""
    path = os.path.join(ROOT, "overrides.json")
    by_year = defaultdict(list)
    bounds = {}
    if os.path.exists(path):
        doc = json.load(open(path))
        for c in doc.get("corrections", []):
            by_year[c["season"]].append(c)
        for b in doc.get("coach_boundaries", []):
            bounds[(b["coach"], b["school"], b["year"])] = b
    return by_year, bounds


def boundary_claims(b, week, season_type):
    """True if this hand-set boundary's coach coached this game."""
    if "through_week" in b:
        return season_type == "regular" and week <= b["through_week"]
    if "from_week" in b:
        return season_type != "regular" or week >= b["from_week"]
    return True


def build_rank_lookups(year):
    """Return (weekly, final): rank[poll_key][teamId] per regular week, and final."""
    weekly = defaultdict(dict)  # week -> pollkey -> {teamId: rank}
    for entry in load(f"rank_reg_{year}.json"):
        wk = entry["week"]
        for poll in entry["polls"]:
            pk = POLLS.get(poll["poll"])
            if not pk:
                continue
            for r in poll["ranks"]:
                weekly[wk].setdefault(pk, {})[r["teamId"]] = r["rank"]
    final = {}  # pollkey -> {teamId: rank}
    post = load(f"rank_post_{year}.json")
    for entry in post:
        for poll in entry["polls"]:
            pk = POLLS.get(poll["poll"])
            if not pk:
                continue
            final.setdefault(pk, {})
            for r in poll["ranks"]:
                final[pk][r["teamId"]] = r["rank"]
    # Apply corrections for known upstream poll errors.
    for c in OVERRIDES.get(year, []):
        target = final.setdefault(c["poll"], {}) if c["phase"] == "final" \
            else weekly[c["phase"]].setdefault(c["poll"], {})
        if c["rank"] is None:
            target.pop(c["teamId"], None)
        else:
            target[c["teamId"]] = c["rank"]
    last_reg_week = max(weekly) if weekly else None
    return weekly, final, last_reg_week


def line_map(year):
    """game_id -> home-team spread (negative = home favored).

    Provider changed over time: 'consensus' (2013–2022), then sportsbooks
    (Bovada/DraftKings/William Hill, 2023+). Prefer a stable source, else any.
    """
    pref = ["consensus", "Bovada", "DraftKings", "William Hill (New Jersey)",
            "teamrankings", "numberfire"]
    m = {}
    if os.path.exists(os.path.join(RAW, f"lines_{year}.json")):
        for g in load(f"lines_{year}.json"):
            avail = {l["provider"]: l.get("spread")
                     for l in g.get("lines", []) if l.get("spread") is not None}
            if not avail:
                continue
            m[g["id"]] = next((avail[p] for p in pref if p in avail),
                              next(iter(avail.values())))
    # Backfill pre-2013 from the Sportsbook Reviews Online archive (see fetch_sbr.py).
    sbr = os.path.join(ROOT, "data", "sbr", f"lines_sbr_{year}.json")
    if os.path.exists(sbr):
        for g in json.load(open(sbr)):
            sp = g["lines"][0].get("spread")
            if g["id"] not in m and sp is not None:
                m[g["id"]] = sp
    return m


def coach_counts():
    """(school,year)->{coach: CFBD game count}, and (coach,school)->first year there."""
    counts = defaultdict(dict)
    first = {}
    for c in load("coaches.json"):
        name = f"{c['firstName']} {c['lastName']}".strip()
        for s in c.get("seasons", []):
            counts[(s["school"], s["year"])][name] = s.get("games") or 0
            k = (name, s["school"])
            first[k] = min(first.get(k, s["year"]), s["year"])
    return counts, first


def assign_year(year, games):
    """Assign each game to exactly one coach per team: (game_id, school) -> coach.

    A season split between coaches (mid-year change or a bowl interim) is divided
    chronologically by CFBD's per-coach game counts — the primary keeps the games
    they coached, the interim gets the tail (usually the bowl). Hand-set boundaries
    override this for the messy cases where CFBD's counts are unreliable.
    """
    sched = defaultdict(list)   # school -> [(startDate, reg/post, week, game_id)]
    meta = {}                   # game_id -> (week, season_type)
    for g in games:
        if not g.get("completed") or g.get("homePoints") is None or g.get("awayPoints") is None:
            continue
        meta[g["id"]] = (g["week"], g["seasonType"])
        post = 0 if g["seasonType"] == "regular" else 1
        for school in (g["homeTeam"], g["awayTeam"]):
            sched[school].append((g.get("startDate") or "", post, g["week"], g["id"]))

    assign = {}
    for school, lst in sched.items():
        lst.sort()
        reg = [x[3] for x in lst if x[1] == 0]     # regular-season game_ids, chronological
        post = [x[3] for x in lst if x[1] == 1]    # postseason game_ids, chronological
        counts = COUNTS.get((school, year), {})
        coaches = list(counts.keys())
        if not coaches:
            continue
        bounded = {c: BOUNDS[(c, school, year)] for c in coaches if (c, school, year) in BOUNDS}
        if bounded:
            unbounded = [c for c in coaches if c not in bounded]
            for gid in reg + post:
                wk, st = meta[gid]
                claimer = next((c for c, b in bounded.items() if boundary_claims(b, wk, st)), None)
                assign[(gid, school)] = claimer or (unbounded[0] if unbounded else None)
            continue
        allg = reg + post   # chronological (regular by date, then postseason)
        if len(coaches) == 1:
            for gid in allg:
                assign[(gid, school)] = coaches[0]
            continue
        # Multiple coaches. If the counts add up, split chronologically ordering the
        # coaches by when their tenure at the school began — the continuing coach took
        # the early games, the arriving coach the late ones (handles both bowl interims
        # and mid-year firings). Suspensions invert this and get a hand-boundary instead.
        if sum(counts.values()) == len(allg) and all(counts.values()):
            order = sorted(coaches, key=lambda c: (FIRST_YR.get((c, school), year), -counts[c]))
            i = 0
            for c in order:
                for gid in allg[i:i + counts[c]]:
                    assign[(gid, school)] = c
                i += counts[c]
        else:                                     # counts unreliable -> primary takes all
            top = max(coaches, key=lambda c: counts[c])
            for gid in allg:
                assign[(gid, school)] = top
    return assign


def rank_at(lookup, teamid):
    return lookup.get(teamid) if lookup else None


OVERRIDES, BOUNDS = load_overrides()
COUNTS, FIRST_YR = coach_counts()


def main():
    con = sqlite3.connect(DB)
    con.executescript("""
    DROP TABLE IF EXISTS games;
    CREATE TABLE games (
      game_id INTEGER, season INTEGER, week INTEGER, season_type TEXT,
      neutral INTEGER, home INTEGER, coach TEXT, team TEXT, opponent TEXT,
      opp_coach TEXT, spread REAL,
      team_pts INTEGER, opp_pts INTEGER, result TEXT,
      team_ap_game INTEGER, opp_ap_game INTEGER,
      team_ap_final INTEGER, opp_ap_final INTEGER,
      team_coaches_game INTEGER, opp_coaches_game INTEGER,
      team_coaches_final INTEGER, opp_coaches_final INTEGER
    );""")

    rows = []
    for gf in sorted(glob.glob(os.path.join(RAW, "games_*.json"))):
        year = int(gf.split("_")[-1].split(".")[0])
        weekly, final, last_reg = build_rank_lookups(year)
        lines = line_map(year)
        year_games = load(os.path.basename(gf))
        assign = assign_year(year, year_games)   # (game_id, school) -> the one coach
        for g in year_games:
            if not g.get("completed"):
                continue
            hp, ap_ = g.get("homePoints"), g.get("awayPoints")
            if hp is None or ap_ is None:
                continue
            # Poll used "at game": that week's poll. Two boundary rules:
            #  - Bowls/playoff: the final regular (post-championship) poll = how teams
            #    enter the postseason.
            #  - Conference-championship week (the max regular poll week): CFBD's poll
            #    for that week is released AFTER those games, so use the prior poll to
            #    get the rank teams ENTERED the game with.
            if g["seasonType"] != "regular":
                wk = last_reg
            elif g["week"] == last_reg:
                wk = max((w for w in weekly if w < last_reg), default=last_reg)
            else:
                wk = g["week"]
            gamepoll = weekly.get(wk, {})
            home_spread = lines.get(g["id"])
            for side in ("home", "away"):
                team, opp = g[f"{side}Team"], g["awayTeam" if side == "home" else "homeTeam"]
                tid, oid = g[f"{side}Id"], g["awayId" if side == "home" else "homeId"]
                tp = hp if side == "home" else ap_
                op = ap_ if side == "home" else hp
                coach = assign.get((g["id"], team))            # the one coach for this game
                opp_coach = assign.get((g["id"], opp))         # opposing coach (head-to-head)
                rows.append((
                    g["id"], year, g["week"], g["seasonType"],
                    1 if g.get("neutralSite") else 0,
                    1 if side == "home" else 0, coach, team, opp, opp_coach,
                    None if home_spread is None else (home_spread if side == "home" else -home_spread),
                    tp, op, "W" if tp > op else ("L" if tp < op else "T"),
                    rank_at(gamepoll.get("ap"), tid), rank_at(gamepoll.get("ap"), oid),
                    rank_at(final.get("ap"), tid), rank_at(final.get("ap"), oid),
                    rank_at(gamepoll.get("coaches"), tid), rank_at(gamepoll.get("coaches"), oid),
                    rank_at(final.get("coaches"), tid), rank_at(final.get("coaches"), oid),
                ))
    con.executemany(f"INSERT INTO games VALUES ({','.join('?'*22)})", rows)
    con.execute("CREATE INDEX ix_coach ON games(coach)")
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM games WHERE coach IS NOT NULL").fetchone()[0]
    print(f"built {DB}: {n} coach-game rows")
    con.close()


if __name__ == "__main__":
    main()
