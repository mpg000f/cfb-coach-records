"""Export a compact browser-ready SQLite: only vs-ranked games, only needed columns."""
import os
import sqlite3

ROOT = os.path.dirname(__file__)
SRC = os.path.join(ROOT, "data", "coach_ranked.db")
OUT = os.path.join(ROOT, "web", "data", "coaches.db")

COLS = """coach, season, week, season_type, team, opponent, team_pts, opp_pts,
result, neutral, home, team_ap_game, opp_ap_game, team_ap_final, opp_ap_final,
team_coaches_game, opp_coaches_game, team_coaches_final, opp_coaches_final"""

# Keep any game where the opponent was ranked (top 25) in any poll, either timing.
RANKED = """opp_ap_game BETWEEN 1 AND 25 OR opp_ap_final BETWEEN 1 AND 25
         OR opp_coaches_game BETWEEN 1 AND 25 OR opp_coaches_final BETWEEN 1 AND 25"""


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    src = sqlite3.connect(SRC)
    rows = src.execute(
        f"SELECT {COLS} FROM games WHERE coach IS NOT NULL AND ({RANKED})").fetchall()

    out = sqlite3.connect(OUT)
    out.execute(f"CREATE TABLE games ({COLS})")
    out.executemany(
        f"INSERT INTO games VALUES ({','.join('?' * 19)})", rows)
    # Coach index for the picker: span + how many ranked games (surfaces big names).
    out.execute("""CREATE TABLE coaches AS
        SELECT coach,
               MIN(season) AS first_year, MAX(season) AS last_year,
               COUNT(*) AS ranked_games
        FROM games GROUP BY coach ORDER BY ranked_games DESC""")
    out.execute("CREATE INDEX ix_coach ON games(coach)")
    out.commit()
    out.execute("VACUUM")
    out.close()
    src.close()
    print(f"wrote {OUT}: {len(rows):,} rows, {os.path.getsize(OUT)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
