# Coach vs. Ranked

**Live:** https://mpg000f.github.io/cfb-coach-records/

A coach-centric college football database: pick a head coach and filter their
career games by opponent rank, matchup type, poll, and rank-timing — or drop a
second coach in and compare the two side by side. Built on the free
[CollegeFootballData](https://collegefootballdata.com) API. All FBS coaches,
full AP-poll era (1936–present), self-updating.

The idea nobody else does: existing tools (Stathead, cfbstats, CBS articles) are
team- or player-centric or static snapshots. This one is filtered **by coach**.

## Pipeline

```
fetch.py     # pull coaches, games, weekly AP/Coaches polls, betting lines (2013+) -> data/raw/
fetch_sbr.py # backfill 2007-2012 pregame spreads from Sportsbook Reviews Online
build.py     # join into data/coach_ranked.db, one row per (coach, game)
export_web.py# compact all-games DB for the browser -> web/data/coaches.db
validate.py  # reconcile against the hand-built AP Top 10 spreadsheet
```

Run: `export CFBD_API_KEY=...`, then `python3 fetch.py && python3 build.py`.
Re-running `fetch.py` only pulls years not already cached.

Each game row carries the coach's team rank and the opponent rank both **at
kickoff** (that week's poll) and **final** (postseason poll), for **AP and
Coaches** polls — so any rank/matchup filter is a plain `WHERE` clause.

## Comparing two coaches

Fill the second coach box (or add `?cmp=<slug>` to a coach URL) and the page turns
into a head-to-head card: both coaches' record, win %, scoring, home/away/neutral
splits, favorite/underdog splits and best win, all computed under the *same*
filters so every row is apples-to-apples. Below it, every game the two actually
coached against each other — that log deliberately ignores the rank filters, since
"every meeting" is more useful than a filtered subset of them.

The season range defaults to 2000–*latest season in the DB*, read from the data at
load rather than hard-coded, so a new season shows up the week it starts.

## Design decisions

- **Join by teamId, not name.** School names drift; IDs are stable (and catch the
  cases where CFBD mislabels a poll entry — see overrides).
- **"Rank at game" for bowls/playoff = the final regular-season (post-championship)
  AP poll** — how teams are actually seeded into the postseason.
- **Conference-championship week:** CFBD's poll for the max regular week is released
  *after* those games, so we use the prior week's poll to get the entering rank.
- **overrides.json** holds hand-maintained fixes for two things:
  - *corrections* — known upstream CFBD poll errors (e.g. the 2023 final AP poll
    files its #9 team as "Mississippi State" when it was Ole Miss).
  - *coach_boundaries* — mid-season coaching changes. CFBD's per-season game counts
    are unreliable for recently-fired coaches (it zeroes them), so we scope tenure
    by hand (e.g. Franklin and Kelly were both fired mid-2025).

## Validation

Reconciled against a hand-built "AP Top 10 Coaches" workbook (33 coaches). The
engine reproduces those records to within ~1 game per coach. Final-AP records
match exactly for most coaches; every residual difference traces to one of:

1. **The workbook is frozen in time** — it predates completed 2024/25 games that
   this DB (correctly) includes. Most "extra" games are this.
2. **Bowl-rank definition** — the workbook sometimes used CFP committee rankings;
   we use the final AP poll by design (a game or two per coach near the top-10 line).
3. **Season-opener poll indexing** *(known limitation)* — a handful of opener games
   (e.g. 2003 USC over #6 Auburn) sit in a CFBD game-week ahead of the preseason
   poll week, so the entering rank isn't matched. Fixing precisely needs actual AP
   poll release dates; the championship-week end of the same issue is already handled.

None of these are join-logic errors; the approach is validated.

## Betting spreads

Each game carries the pregame point spread from the coach's-team perspective
(negative = favored). Coverage: CFBD provides lines from **2013**; **2007–2012**
is backfilled from Sportsbook Reviews Online (parsed HTML, matched to CFBD games
by season + final scores with home/away-orientation handling for neutral sites).
Validated: favorites win ~77–79% straight-up and cover ~48–49% ATS in both
sources, confirming consistent sign/magnitude. Pre-2007 has no spread data.

## Refresh schedule

`.github/workflows/refresh.yml` runs **Tuesdays at 09:00 UTC** (05:00 ET) and
`pages.yml` redeploys the site when it commits. Tuesday rather than Monday on
purpose: it clears Sunday's AP/Coaches poll releases *and* the occasional Monday
game (Labor Day openers, some bowls). `check_refresh.py` gates the commit — if the
rebuilt DB shrinks or fails an anchor record, the job aborts without publishing.

## TODO

- Extend overrides as validation surfaces more upstream quirks / coaching changes
