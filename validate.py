"""Reconcile the built DB against the AP Top 10 spreadsheet's Expanded Summary."""
import os
import sqlite3

DB = os.path.join(os.path.dirname(__file__), "data", "coach_ranked.db")

# (coach, vs-Top10-at-game, vs-final-Top10, qualifying-union) from the workbook.
EXPECTED = {
    "James Franklin": ("5-26", "4-31", 38),
    "Brian Kelly": ("8-22", "5-28", 42),
    "Kirby Smart": ("25-11", "18-12", 40),
    "Nick Saban": ("50-27", "30-32", 90),
    "Urban Meyer": ("26-9", "14-14", 41),
    "Pete Carroll": ("14-4", "12-4", 22),
    "Lincoln Riley": ("5-9", "5-16", 23),
    "Dabo Swinney": ("20-15", "9-20", 43),
    "Mack Brown": ("14-37", "8-34", 59),
    "Les Miles": ("18-22", "12-27", 52),
}


def rec(con, coach, col):
    """W-L string vs opponents ranked 1..10 in the given rank column."""
    q = f"""SELECT
        SUM(result='W'), SUM(result='L')
        FROM games WHERE coach=? AND {col} BETWEEN 1 AND 10"""
    w, l = con.execute(q, (coach,)).fetchone()
    return f"{w or 0}-{l or 0}"


def union_count(con, coach):
    q = """SELECT COUNT(*) FROM games WHERE coach=?
           AND ((opp_ap_game BETWEEN 1 AND 10) OR (opp_ap_final BETWEEN 1 AND 10))"""
    return con.execute(q, (coach,)).fetchone()[0]


def main():
    con = sqlite3.connect(DB)
    print(f"{'Coach':<16} {'at-game':>10} {'exp':>7}  {'final':>10} {'exp':>7}  {'qual':>5} {'exp':>4}")
    ok = True
    for coach, (eg, ef, eq) in EXPECTED.items():
        g = rec(con, coach, "opp_ap_game")
        f = rec(con, coach, "opp_ap_final")
        q = union_count(con, coach)
        gm = "OK" if g == eg else "XX"
        fm = "OK" if f == ef else "XX"
        qm = "OK" if q == eq else "XX"
        if "XX" in (gm, fm, qm):
            ok = False
        print(f"{coach:<16} {g:>10} {eg:>7}{gm}  {f:>10} {ef:>7}{fm}  {q:>5} {eq:>4}{qm}")
    print("\nALL MATCH" if ok else "\nDISCREPANCIES — investigate")
    con.close()


if __name__ == "__main__":
    main()
