"""Sanity guard for the weekly refresh.

Exits nonzero if the freshly rebuilt web DB looks broken, so the refresh workflow
aborts before committing/deploying bad data. Checks absolute sanity (row/coach
counts, a set of stable historical anchor records) and a relative check against
the previously committed DB (no sudden large shrink).
"""
import os
import sqlite3
import subprocess
import sys
import tempfile

DB = os.path.join(os.path.dirname(__file__), "web", "data", "coaches.db")

MIN_ROWS = 90000
MIN_COACHES = 1200
MAX_SHRINK = 0.05          # rows may not drop more than 5% vs the committed DB

# Retired coaches → permanently stable records; Ivey guards the interim-attribution fix.
ANCHORS = [
    ("Pete Carroll", "opp_ap_game BETWEEN 1 AND 10", (13, 3)),
    ("Urban Meyer",  "opp_ap_game BETWEEN 1 AND 10", (25, 8)),
    ("Bob Stoops",   "opp_ap_game BETWEEN 1 AND 10", (20, 17)),
    ("Nick Saban",   "1=1",                          (298, 71)),
    ("Mark Ivey",    "1=1",                          (1, 0)),
]


def rec(con, coach, cond):
    w, l = con.execute(
        f"SELECT SUM(result='W'), SUM(result='L') FROM games WHERE coach=? AND {cond}",
        (coach,)).fetchone()
    return (w or 0, l or 0)


def main():
    con = sqlite3.connect(DB)
    fails = []

    rows = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    coaches = con.execute("SELECT COUNT(*) FROM coaches").fetchone()[0]
    if rows < MIN_ROWS:
        fails.append(f"row count too low: {rows} < {MIN_ROWS}")
    if coaches < MIN_COACHES:
        fails.append(f"coach count too low: {coaches} < {MIN_COACHES}")

    for coach, cond, exp in ANCHORS:
        got = rec(con, coach, cond)
        if got != exp:
            fails.append(f"anchor {coach} [{cond}]: got {got}, expected {exp}")

    # Relative: compare against the DB currently committed at HEAD.
    try:
        old = subprocess.run(["git", "show", "HEAD:web/data/coaches.db"],
                             capture_output=True, check=True).stdout
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
            tf.write(old)
            tmp = tf.name
        orows = sqlite3.connect(tmp).execute("SELECT COUNT(*) FROM games").fetchone()[0]
        os.unlink(tmp)
        if rows < orows * (1 - MAX_SHRINK):
            fails.append(f"rows dropped >{MAX_SHRINK:.0%}: {orows} -> {rows}")
        else:
            print(f"baseline compare: {orows} -> {rows} rows (ok)")
    except Exception as e:
        print(f"note: skipping baseline compare ({e})")

    if fails:
        print("REFRESH GUARD FAILED:")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print(f"refresh guard OK: {rows} rows, {coaches} coaches, {len(ANCHORS)} anchors pass")


if __name__ == "__main__":
    main()
