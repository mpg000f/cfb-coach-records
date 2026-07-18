"""Export a compact browser-ready SQLite of every coach-game (needed columns only).

Includes all games (not just vs-ranked) so opponent and head-to-head records are
complete; the rank columns let the UI filter to ranked matchups on demand.
"""
import os
import sqlite3

ROOT = os.path.dirname(__file__)
SRC = os.path.join(ROOT, "data", "coach_ranked.db")
OUT = os.path.join(ROOT, "web", "data", "coaches.db")

COLS = """coach, season, week, season_type, team, opponent, opp_coach, spread,
team_pts, opp_pts, result, neutral, home, team_ap_game, opp_ap_game, team_ap_final,
opp_ap_final, team_coaches_game, opp_coaches_game, team_coaches_final, opp_coaches_final"""


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    src = sqlite3.connect(SRC)
    rows = src.execute(
        f"SELECT {COLS} FROM games WHERE coach IS NOT NULL").fetchall()

    out = sqlite3.connect(OUT)
    out.execute(f"CREATE TABLE games ({COLS})")
    out.executemany(f"INSERT INTO games VALUES ({','.join('?' * 21)})", rows)
    # Coach index for the picker: span + total games (surfaces long careers).
    out.execute("""CREATE TABLE coaches AS
        SELECT coach,
               MIN(season) AS first_year, MAX(season) AS last_year,
               COUNT(*) AS games
        FROM games GROUP BY coach ORDER BY games DESC""")
    out.execute("CREATE INDEX ix_coach ON games(coach)")
    out.commit()
    out.execute("VACUUM")
    out.close()
    src.close()
    print(f"wrote {OUT}: {len(rows):,} rows, {os.path.getsize(OUT)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
