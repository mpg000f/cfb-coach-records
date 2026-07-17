# Coach vs. Ranked

A coach-centric college football database: pick a head coach and filter their
career games by opponent rank, matchup type, poll, and rank-timing. Built on the
free [CollegeFootballData](https://collegefootballdata.com) API. All FBS coaches,
full AP-poll era (1936–present), self-updating.

The idea nobody else does: existing tools (Stathead, cfbstats, CBS articles) are
team- or player-centric or static snapshots. This one is filtered **by coach**.

## Pipeline

```
fetch.py    # pull coaches, games, and weekly AP/Coaches polls -> data/raw/*.json (cached)
build.py    # join into data/coach_ranked.db, one row per (coach, game)
validate.py # reconcile against the hand-built AP Top 10 spreadsheet
```

Run: `export CFBD_API_KEY=...`, then `python3 fetch.py && python3 build.py`.
Re-running `fetch.py` only pulls years not already cached.

Each game row carries the coach's team rank and the opponent rank both **at
kickoff** (that week's poll) and **final** (postseason poll), for **AP and
Coaches** polls — so any rank/matchup filter is a plain `WHERE` clause.

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

## TODO (build phase)

- Weekly in-season refresh job (cron / GitHub Action)
- Public web front end (coach picker + rank/matchup/poll filters)
- Extend overrides as validation surfaces more upstream quirks / coaching changes
