"""Pull raw CFBD data (coaches, games, weekly rankings) into data/raw/ as cached JSON."""
import json
import os
import time
import urllib.request
import urllib.error

API = "https://api.collegefootballdata.com"
KEY = os.environ.get("CFBD_API_KEY", "")
RAW = os.path.join(os.path.dirname(__file__), "data", "raw")

# AP poll began 1936; CFBD game+ranking coverage is solid across this span.
START_YEAR = 1936
END_YEAR = 2025
LINES_START = 2013   # CFBD betting-line coverage begins here


def get(path, params, dest):
    """Fetch one endpoint to a cache file, skipping if already present."""
    if os.path.exists(dest):
        return json.load(open(dest))
    qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{API}{path}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            json.dump(data, open(dest, "w"))
            time.sleep(0.15)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"failed: {url}")


def main():
    assert KEY, "set CFBD_API_KEY"
    os.makedirs(RAW, exist_ok=True)
    # Coaches: one call covers all of history.
    coaches = get("/coaches", {"minYear": START_YEAR, "maxYear": END_YEAR},
                  os.path.join(RAW, "coaches.json"))
    print(f"coaches: {len(coaches)}")
    for year in range(START_YEAR, END_YEAR + 1):
        g = get("/games", {"year": year, "seasonType": "both"},
                os.path.join(RAW, f"games_{year}.json"))
        r = get("/rankings", {"year": year, "seasonType": "regular"},
                os.path.join(RAW, f"rank_reg_{year}.json"))
        p = get("/rankings", {"year": year, "seasonType": "postseason"},
                os.path.join(RAW, f"rank_post_{year}.json"))
        nlines = 0
        if year >= LINES_START:
            l = get("/lines", {"year": year}, os.path.join(RAW, f"lines_{year}.json"))
            nlines = sum(1 for x in l if x.get("lines"))
        print(f"{year}: {len(g)} games, {len(r)} reg-poll-weeks, {len(p)} post, {nlines} lines")


if __name__ == "__main__":
    main()
