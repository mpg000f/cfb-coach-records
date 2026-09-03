"use strict";

let db = null;
let coaches = [];       // {coach, first_year, last_year, games}
let selectedCoach = null;
let compareCoach = null;   // second coach for the side-by-side view (null = off)
let MAXY = 2025;           // latest season in the DB; set at load
const state = { poll: "ap", timing: "game" };
let sortState = { col: "pct", dir: "desc" };  // leaderboard sort

const $ = (s) => document.querySelector(s);

// Resolve the app root from this script's own URL so assets and routing work
// identically at "/" (homepage) and "/c/<slug>.html" (pre-rendered coach pages).
const ROOT = (document.currentScript ? document.currentScript.src
  : [...document.scripts].map((s) => s.src).find((s) => /app\.js(\?|$)/.test(s)))
  .replace(/app\.js.*$/, "");
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let slugToCoach = {};

async function init() {
  const results = $("#results");
  results.innerHTML = '<p class="loading">Loading database (~3 MB transfer, first visit only)…</p>';
  try {
    const SQL = await initSqlJs({ locateFile: (f) => ROOT + "vendor/" + f });
    const buf = await fetch(ROOT + "data/coaches.db").then((r) => r.arrayBuffer());
    db = new SQL.Database(new Uint8Array(buf));
    coaches = rows("SELECT coach, first_year, last_year, games FROM coaches");
    coaches.forEach((c) => { slugToCoach[slugify(c.coach)] = c.coach; });
    MAXY = rows("SELECT MAX(season) AS y FROM games")[0].y;
    $("#y1").max = $("#y2").max = MAXY;
    $("#allcoaches").innerHTML = coaches
      .map((c) => `<option value="${esc(c.coach)}">`).join("");
    wireUI();
    applyFromURL();               // render from the current URL (shareable/deep-linkable)
    window.addEventListener("popstate", applyFromURL);
  } catch (e) {
    results.innerHTML = '<p class="empty">Could not load the database. ' + e.message + "</p>";
  }
}

// --- query helpers ------------------------------------------------------
function rows(sql, params) {
  const st = db.prepare(sql);
  if (params) st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

function rankCols() {
  const poll = state.poll === "coaches" ? "coaches" : "ap";
  const timing = state.timing === "final" ? "final" : "game";
  return { opp: `opp_${poll}_${timing}`, team: `team_${poll}_${timing}` };
}

function currentFilters(ov) {
  const f = {
    thr: parseInt($("#thr").value, 10) || 0,        // 0 = Any (no opp-rank limit)
    teamThr: parseInt($("#tthr").value, 10) || 0,
    min: Math.max(1, parseInt($("#min").value, 10) || 1),
    loc: $("#loc").value,
    spread: $("#spread").value,
    opp: $("#opp").value.trim(),
    oppCoach: $("#oppcoach").value.trim(),
    y1: parseInt($("#y1").value, 10) || 1936,
    y2: parseInt($("#y2").value, 10) || MAXY,
  };
  return ov ? { ...f, ...ov } : f;
}

// Shared WHERE clause + params for a coach's games under current filters.
function buildQuery(select, coach, ov) {
  const c = rankCols();
  const f = currentFilters(ov);
  const where = [`coach = $coach`, `season BETWEEN $y1 AND $y2`];
  const p = { $coach: coach, $y1: f.y1, $y2: f.y2 };
  // Rank threshold: -1 = unranked (not in the poll), 0 = any, N = Top N.
  if (f.thr === -1) where.push(`${c.opp} IS NULL`);
  else if (f.thr) { where.push(`${c.opp} BETWEEN 1 AND $thr`); p.$thr = f.thr; }
  if (f.teamThr === -1) where.push(`${c.team} IS NULL`);
  else if (f.teamThr) { where.push(`${c.team} BETWEEN 1 AND $tthr`); p.$tthr = f.teamThr; }
  if (f.loc === "neutral") where.push(`neutral = 1`);
  else if (f.loc === "home") where.push(`home = 1 AND neutral = 0`);
  else if (f.loc === "away") where.push(`home = 0 AND neutral = 0`);
  if (f.spread === "fav") where.push(`spread < 0`);
  else if (f.spread === "dog") where.push(`spread > 0`);
  if (f.opp) {
    const terms = f.opp.split(",").map((s) => s.trim()).filter(Boolean);
    const ors = terms.map((t, i) => { p["$opp" + i] = "%" + t + "%"; return `opponent LIKE $opp${i}`; });
    if (ors.length) where.push("(" + ors.join(" OR ") + ")");
  }
  if (f.oppCoach) { where.push(`opp_coach = $oc`); p.$oc = f.oppCoach; }
  return {
    sql: select.replace(/\{team_rank\}/g, c.team).replace(/\{opp_rank\}/g, c.opp)
      + " WHERE " + where.join(" AND "),
    params: p,
  };
}

// --- URL state ----------------------------------------------------------
function stateToParams() {
  const f = currentFilters();
  const p = new URLSearchParams();
  // Coach lives in the path (/c/<slug>.html), not the query.
  if (state.poll !== "ap") p.set("poll", state.poll);
  if (state.timing !== "game") p.set("t", state.timing);
  if (f.thr !== 10) p.set("thr", f.thr);
  if (f.teamThr) p.set("tthr", f.teamThr);
  if (f.min !== 10) p.set("min", f.min);
  if (f.loc !== "all") p.set("loc", f.loc);
  if (f.spread !== "all") p.set("spread", f.spread);
  if (f.opp) p.set("opp", f.opp);
  if (f.oppCoach) p.set("vs", f.oppCoach);
  if (compareCoach) p.set("cmp", slugify(compareCoach));
  if (f.y1 !== 2000) p.set("y1", f.y1);
  if (f.y2 !== MAXY) p.set("y2", f.y2);
  if (!selectedCoach && !(sortState.col === "pct" && sortState.dir === "desc"))
    p.set("sort", sortState.col + "." + sortState.dir);
  return p;
}

function syncURL(push) {
  const qs = stateToParams().toString();
  const base = selectedCoach ? ROOT + "c/" + slugify(selectedCoach) + ".html" : ROOT;
  const url = base + (qs ? "?" + qs : "");
  history[push ? "pushState" : "replaceState"](null, "", url);
}

function setSeg(group, val) {
  document.querySelectorAll(`.seg[data-group="${group}"] button`).forEach((b) =>
    b.classList.toggle("on", b.dataset.val === val));
}

function applyFromURL() {
  const p = new URLSearchParams(location.search);
  state.poll = p.get("poll") === "coaches" ? "coaches" : "ap";
  state.timing = p.get("t") === "final" ? "final" : "game";
  setSeg("poll", state.poll); setSeg("timing", state.timing);
  $("#thr").value = p.get("thr") ?? "10";
  $("#tthr").value = p.get("tthr") ?? "0";
  $("#min").value = p.get("min") ?? "10";
  $("#loc").value = p.get("loc") ?? "all";
  $("#spread").value = p.get("spread") ?? "all";
  $("#opp").value = p.get("opp") ?? "";
  $("#oppcoach").value = p.get("vs") ?? "";
  $("#y1").value = p.get("y1") ?? "2000";
  $("#y2").value = p.get("y2") ?? String(MAXY);
  const s = p.get("sort");
  sortState = s ? { col: s.split(".")[0], dir: s.split(".")[1] || "desc" }
                : { col: "pct", dir: "desc" };
  // Coach from the path (/c/<slug>.html), falling back to a legacy ?coach= param.
  const m = location.pathname.match(/\/c\/([^/]+)\.html$/);
  selectedCoach = (m && slugToCoach[m[1]]) || p.get("coach") || null;
  compareCoach = resolveCoach(p.get("cmp"));
  $("#coach-input").value = selectedCoach || "";
  $("#compare-input").value = compareCoach || "";
  refresh();
}

// Accept either a slug (from the URL) or a plain name; null if we can't place it.
function resolveCoach(s) {
  if (!s) return null;
  return slugToCoach[s] || slugToCoach[slugify(s)] || null;
}

function refresh() {
  if (selectedCoach && compareCoach && compareCoach !== selectedCoach) renderCompare();
  else if (selectedCoach) renderCoach();
  else renderLeaderboard();
}

// --- coach detail -------------------------------------------------------
const GAME_SELECT =
  `SELECT season, week, season_type, team, opponent, opp_coach, spread, team_pts, opp_pts,
          result, neutral, home, {team_rank} AS tr, {opp_rank} AS orr FROM games`;

// A coach's filtered games, oldest first. `ov` overrides individual filters.
function gamesFor(coach, ov) {
  const q = buildQuery(GAME_SELECT, coach, ov);
  return rows(q.sql + " ORDER BY season, week", q.params);
}

function renderCoach() {
  const g = gamesFor(selectedCoach);
  const { w, l, t, pct: p0 } = recOf(g);
  const pct = p0 ?? 0;
  const f = currentFilters();

  const h2h = f.oppCoach ? ` vs ${esc(f.oppCoach)}` : "";
  const statsGrid = '<div class="summary" style="display:grid">'
    + stat(`${w}–${l}${t ? "–" + t : ""}`, "Record")
    + stat((pct * 100).toFixed(1) + "%", "Win %")
    + stat(g.length, "Games")
    + stat(spanOf(selectedCoach), "Span") + "</div>";

  // Schools this coach was at (within the filtered set).
  const schools = rows(
    `SELECT team, MIN(season) a, MAX(season) b, COUNT(*) n FROM games
     WHERE coach = $c GROUP BY team ORDER BY a`, { $c: selectedCoach });
  const chips = schools.map((s) =>
    `<span class="chip">${esc(s.team)} <em>${s.a === s.b ? s.a : s.a + "–" + s.b}</em></span>`).join("");

  // Pregame-line breakdown (spreads exist from 2013 on).
  const wl = g.filter((r) => r.spread != null);
  let betting = "";
  if (wl.length) {
    const rec = (a) => { let w = 0, l = 0; a.forEach((r) => r.result === "W" ? w++ : r.result === "L" ? l++ : 0); return `${w}–${l}`; };
    const fav = wl.filter((r) => r.spread < 0), dog = wl.filter((r) => r.spread > 0);
    betting = `<p class="betting">Pregame favorite in <b>${fav.length} of ${wl.length}</b>
      games with a line (${Math.round(fav.length / wl.length * 100)}%) ·
      as favorite <b>${rec(fav)}</b> · as underdog <b>${rec(dog)}</b>
      <span class="hint">lines: 2007–present</span></p>`;
  }

  const head = `<div class="detail-head">
      <a class="back" href="${ROOT}">← All coaches</a>
      <h2 class="coach-title">${esc(selectedCoach)}${h2h}</h2>
      <div class="schools">${chips}</div>
      <p class="sub">${label(f)}</p>
    </div>`;

  if (!g.length) {
    $("#results").innerHTML = head + statsGrid + betting + '<p class="empty">No games match these filters.</p>';
    return;
  }
  $("#results").innerHTML = head + statsGrid + betting + gameTable(g);
}

function gameTable(g) {
  const body = g.map((r) => {
    const loc = r.neutral ? "vs" : (r.home ? "vs" : "at");
    const site = r.neutral ? ' <span class="hint">(N)</span>' : "";
    return `<tr>
      <td class="num">${r.season}</td>
      <td>${esc(r.team)}</td>
      <td>${loc} ${esc(r.opponent)}${site}</td>
      <td>${r.opp_coach ? esc(r.opp_coach) : "—"}</td>
      <td class="num">${rk(r.orr)}</td>
      <td class="num">${rk(r.tr)}</td>
      <td class="num">${spr(r.spread)}</td>
      <td class="num">${r.team_pts}–${r.opp_pts}</td>
      <td class="res ${r.result}">${r.result}</td>
    </tr>`;
  }).join("");
  return `<div class="table-scroll"><table>
      <thead><tr><th>Season</th><th>Team</th><th>Opponent</th><th>Opp. coach</th>
      <th>Opp rank</th><th>Team rank</th><th>Line</th><th>Score</th><th>Res</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

// --- compare two coaches ------------------------------------------------
// Both sides are computed under the same filters, so every row is apples-to-apples.
function sideStats(coach) {
  const g = gamesFor(coach);
  const s = recOf(g);
  s.coach = coach;
  s.games = g;
  s.schools = rows(`SELECT team FROM games WHERE coach = $c GROUP BY team ORDER BY MIN(season)`,
    { $c: coach }).map((r) => r.team);
  return s;
}

// Highest-ranked opponent this coach beat (lower number = better win).
function bestWin(g) {
  const wins = g.filter((r) => r.result === "W" && r.orr);
  if (!wins.length) return { text: "—", rank: null };
  const b = wins.reduce((x, y) => (y.orr < x.orr ? y : x));
  return { text: `#${b.orr} ${esc(b.opponent)} <span class="hint">${b.season}</span>`, rank: b.orr };
}

// One row per metric: displayed value for each side, plus which side wins it.
function metricRows(A, B) {
  const M = [];
  // cmpA/cmpB are the sortable numbers behind the displayed strings; null = don't judge.
  const push = (label, va, vb, cmpA, cmpB, higher = true) => {
    let better = null;
    if (cmpA != null && cmpB != null && cmpA !== cmpB) better = (cmpA > cmpB) === higher ? "a" : "b";
    M.push({ label, va, vb, better });
  };
  const split = (label, fn) => {
    const a = recOf(A.games.filter(fn)), b = recOf(B.games.filter(fn));
    push(label, `${recStr(a)} <span class="hint">${pctStr(a.pct)}</span>`,
                `${recStr(b)} <span class="hint">${pctStr(b.pct)}</span>`, a.pct, b.pct);
  };
  const margin = (s) => mean(s.games.map((r) => r.team_pts - r.opp_pts));

  push("Record", recStr(A), recStr(B), A.pct, B.pct);
  push("Win %", pctStr(A.pct), pctStr(B.pct), A.pct, B.pct);
  push("Games", A.n, B.n, null, null);
  push("Avg margin", signed(margin(A)), signed(margin(B)), margin(A), margin(B));
  push("Points / game", num1(mean(A.games.map((r) => r.team_pts))), num1(mean(B.games.map((r) => r.team_pts))),
       mean(A.games.map((r) => r.team_pts)), mean(B.games.map((r) => r.team_pts)));
  const paA = mean(A.games.map((r) => r.opp_pts)), paB = mean(B.games.map((r) => r.opp_pts));
  push("Points allowed / game", num1(paA), num1(paB), paA, paB, false);
  split("Home", (r) => r.home && !r.neutral);
  split("Away", (r) => !r.home && !r.neutral);
  split("Neutral site", (r) => !!r.neutral);
  split("As favorite", (r) => r.spread != null && r.spread < 0);
  split("As underdog", (r) => r.spread != null && r.spread > 0);
  const bwA = bestWin(A.games), bwB = bestWin(B.games);
  push("Best win", bwA.text, bwB.text, bwA.rank, bwB.rank, false);
  push("Span", spanOf(A.coach), spanOf(B.coach), null, null);
  push("Schools", A.schools.map(esc).join(", ") || "—", B.schools.map(esc).join(", ") || "—", null, null);
  return M;
}

function renderCompare() {
  const f = currentFilters();
  const A = sideStats(selectedCoach), B = sideStats(compareCoach);

  const head = `<div class="detail-head">
      <a class="back" href="${ROOT}">← All coaches</a>
      <h2 class="coach-title">${esc(A.coach)} <span class="vs-sep">vs</span> ${esc(B.coach)}</h2>
      <p class="sub">${label(f)}</p>
      <div class="cmp-actions">
        <button type="button" id="cmp-swap">⇄ Swap sides</button>
        <button type="button" id="cmp-clear">✕ Clear comparison</button>
      </div>
    </div>`;

  // Headline card per coach. Both meters run 0–100%, so their lengths compare directly.
  const side = (s, k) => `<div class="duel-side ${k}">
      <a class="duel-name" href="${ROOT}c/${slugify(s.coach)}.html" data-coach="${esc(s.coach)}">${esc(s.coach)}</a>
      <div class="duel-rec">${recStr(s)}</div>
      <div class="duel-pct">${pctStr(s.pct)} <span class="hint">win rate</span></div>
      <div class="duel-track" role="img" aria-label="${esc(s.coach)} win rate ${pctStr(s.pct)}">
        <span class="${k}" style="width:${((s.pct ?? 0) * 100).toFixed(1)}%"></span>
      </div>
      <div class="duel-meta">${s.n} game${s.n === 1 ? "" : "s"} · ${spanOf(s.coach)}</div>
    </div>`;
  const duel = `<div class="duel">${side(A, "a")}<div class="duel-mid">vs</div>${side(B, "b")}</div>`;

  if (!A.n && !B.n) {
    $("#results").innerHTML = head + duel + '<p class="empty">Neither coach has a game matching these filters.</p>';
    wireCompareActions();
    return;
  }

  const body = metricRows(A, B).map((m) => `<tr>
      <td class="cmp-val a${m.better === "a" ? " win" : ""}">${m.va}</td>
      <td class="cmp-key">${m.label}</td>
      <td class="cmp-val b${m.better === "b" ? " win" : ""}">${m.vb}</td>
    </tr>`).join("");
  const table = `<div class="table-scroll"><table class="cmp">
      <thead><tr><th class="cmp-val a">${esc(A.coach)}</th><th class="cmp-key"></th>
      <th class="cmp-val b">${esc(B.coach)}</th></tr></thead><tbody>${body}</tbody></table></div>`;

  // Did they ever actually play each other? Ignore the rank filters here —
  // every meeting in the season range is more useful than a filtered subset.
  const meet = gamesFor(A.coach,
    { thr: 0, teamThr: 0, loc: "all", spread: "all", opp: "", oppCoach: B.coach });
  let h2h = "";
  if (meet.length) {
    const r = recOf(meet);
    h2h = `<p class="sect-title">Head to head — ${esc(A.coach)} is ${recStr(r)}
      <span class="hint">(${meet.length} meeting${meet.length === 1 ? "" : "s"}, ${f.y1}–${f.y2}, all opponents' ranks)</span></p>`
      + gameTable(meet);
  } else {
    h2h = `<p class="sect-title">Head to head</p>
      <p class="empty">These two never met between ${f.y1} and ${f.y2}.</p>`;
  }

  $("#results").innerHTML = head + duel + table + h2h;
  wireCompareActions();
}

function wireCompareActions() {
  const swap = $("#cmp-swap"), clear = $("#cmp-clear");
  if (swap) swap.addEventListener("click", () => {
    const a = selectedCoach;
    selectedCoach = compareCoach; compareCoach = a;
    $("#coach-input").value = selectedCoach; $("#compare-input").value = compareCoach;
    syncURL(true); renderCompare(); window.scrollTo({ top: 0, behavior: "smooth" });
  });
  if (clear) clear.addEventListener("click", () => setCompare(null));
  $("#results").querySelectorAll(".duel-name").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); setCompare(null); pickCoach(el.dataset.coach); }));
}

// --- leaderboard --------------------------------------------------------
const LEAD_COLS = [
  { key: "coach", label: "Coach", get: (r) => r.coach.toLowerCase(), asc: true },
  { key: "games", label: "Games", get: (r) => r.dec },
  { key: "wins", label: "Record", get: (r) => r.w },
  { key: "pct", label: "Win %", get: (r) => r.pct },
];
const LEAD_MAX = 100;

function renderLeaderboard() {
  const c = rankCols();
  const f = currentFilters();
  const q = buildQuery(
    `SELECT coach, SUM(result='W') AS w, SUM(result='L') AS l, SUM(result='T') AS t FROM games`,
    "");
  // buildQuery pins coach = ''; swap that for a GROUP BY across all coaches.
  const sql = q.sql.replace("coach = $coach AND ", "") + " GROUP BY coach HAVING (w+l) >= " + f.min;
  const params = { ...q.params }; delete params.$coach;
  const board = rows(sql, params);
  board.forEach((r) => { r.dec = r.w + r.l; r.pct = r.dec ? r.w / r.dec : 0; });

  const col = LEAD_COLS.find((x) => x.key === sortState.col) || LEAD_COLS[3];
  board.sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    let cmp = x < y ? -1 : x > y ? 1 : 0;
    if (cmp === 0) cmp = (a.w - b.w) || (a.pct - b.pct);
    return sortState.dir === "desc" ? -cmp : cmp;
  });
  const shown = board.slice(0, LEAD_MAX);

  const arrow = (k) => sortState.col === k ? (sortState.dir === "desc" ? " ▾" : " ▴") : "";
  const heads = `<th>#</th>` + LEAD_COLS.map((x) =>
    `<th class="sortable${sortState.col === x.key ? " sorted" : ""}" data-col="${x.key}">${x.label}${arrow(x.key)}</th>`).join("");
  const body = shown.map((r, i) => {
    const rank = i < 3 ? `<span class="medal m${i + 1}">${i + 1}</span>` : (i + 1);
    const p = r.pct * 100;
    const meter = `<span class="meter"><span style="width:${p.toFixed(0)}%;background:hsl(${Math.round(p * 1.2)} 62% 45%)"></span></span>`;
    return `<tr>
      <td class="rankcell">${rank}</td>
      <td><a class="lead-name" href="${ROOT}c/${slugify(r.coach)}.html" data-coach="${esc(r.coach)}">${esc(r.coach)}</a></td>
      <td class="num">${r.dec}</td>
      <td class="num">${r.w}–${r.l}${r.t ? "–" + r.t : ""}</td>
      <td><div class="pctcell">${meter}<span class="pctnum">${p.toFixed(1)}%</span></div></td></tr>`;
  }).join("");
  const note = board.length > LEAD_MAX ? ` · showing ${LEAD_MAX} of ${board.length}` : "";
  const hint = compareCoach
    ? `<p class="empty cmp-hint">Pick a first coach to compare against ${esc(compareCoach)}.</p>` : "";
  $("#results").innerHTML = hint + `<p class="sect-title">Leaderboard — ${label(f)} · min ${f.min} games${note}</p>
    <div class="table-scroll"><table>
      <thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table></div>`;
  $("#results").querySelectorAll(".lead-name").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); pickCoach(el.dataset.coach); }));
  $("#results").querySelectorAll("th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.col, def = LEAD_COLS.find((x) => x.key === key);
      if (sortState.col === key) sortState.dir = sortState.dir === "desc" ? "asc" : "desc";
      else sortState = { col: key, dir: def.asc ? "asc" : "desc" };
      syncURL(false); renderLeaderboard();
    }));
}

// --- labels & small helpers --------------------------------------------
function label(f) {
  const poll = state.poll === "coaches" ? "Coaches" : "AP";
  const timing = state.timing === "final" ? "final" : "at kickoff";
  let base = f.thr === -1 ? "vs unranked" : f.thr ? `vs Top ${f.thr}` : "vs all opponents";
  if (f.teamThr === -1) base = `unranked team ${base}`;
  else if (f.teamThr) base = `Top ${f.teamThr} team ${base}`;
  const extra = [];
  if (f.opp) extra.push("vs " + f.opp);
  if (f.oppCoach) extra.push("H2H " + f.oppCoach);
  if (f.spread === "fav") extra.push("as favorite");
  else if (f.spread === "dog") extra.push("as underdog");
  return `${base} (${poll}, ${timing})${extra.length ? " · " + extra.join(" · ") : ""}`;
}
// Tally W/L/T over a set of games. pct is null when there's nothing decided.
function recOf(list) {
  let w = 0, l = 0, t = 0;
  for (const r of list) { if (r.result === "W") w++; else if (r.result === "L") l++; else t++; }
  return { w, l, t, n: list.length, dec: w + l, pct: w + l ? w / (w + l) : null };
}
const recStr = (r) => r.n ? `${r.w}–${r.l}${r.t ? "–" + r.t : ""}` : "—";
const pctStr = (p) => p == null ? "—" : (p * 100).toFixed(1) + "%";
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const num1 = (v) => v == null ? "—" : v.toFixed(1);
const signed = (v) => v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1);
const spanOf = (name) => { const c = coaches.find((x) => x.coach === name); return c ? c.first_year + "–" + c.last_year : "—"; };
const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
const rk = (n) => n ? `<span class="rk">#${n}</span>` : "—";
const spr = (s) => s == null ? "—" : s === 0 ? "PK"
  : `<span class="${s < 0 ? "fav" : "dog"}">${s < 0 ? s : "+" + s}</span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

// --- UI wiring ----------------------------------------------------------
function pickCoach(name) {
  selectedCoach = name;
  $("#coach-input").value = name;
  $("#coach-list").hidden = true;
  syncURL(true);
  refresh();                       // compare view if a second coach is set
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// name === null turns the comparison off.
function setCompare(name) {
  compareCoach = name;
  $("#compare-input").value = name || "";
  $("#compare-list").hidden = true;
  syncURL(true);
  refresh();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goHome(e) {
  if (e) e.preventDefault();
  selectedCoach = null;
  compareCoach = null;
  $("#coach-input").value = "";
  $("#compare-input").value = "";
  syncURL(true);
  renderLeaderboard();
}

function onFilterChange() { syncURL(false); refresh(); }

// Type-ahead coach picker. Used for both the primary and the compare slot.
function wireCombo(inputSel, listSel, onPick) {
  const input = $(inputSel);
  const list = $(listSel);
  let active = -1;

  const showList = () => {
    const q = input.value.trim().toLowerCase();
    const items = (q ? coaches.filter((c) => c.coach.toLowerCase().includes(q)) : coaches).slice(0, 40);
    active = -1;
    if (!items.length) { list.hidden = true; return; }
    list.innerHTML = items.map((c) =>
      `<li role="option" data-coach="${esc(c.coach)}">
        <span class="cn">${esc(c.coach)}</span>
        <span class="cm">${c.first_year}–${c.last_year} · ${c.games} games</span>
      </li>`).join("");
    list.hidden = false;
    list.querySelectorAll("li").forEach((li) =>
      li.addEventListener("mousedown", (e) => { e.preventDefault(); onPick(li.dataset.coach); }));
  };

  input.addEventListener("input", showList);
  input.addEventListener("focus", showList);
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    const lis = [...list.querySelectorAll("li")];
    if (e.key === "ArrowDown") { active = Math.min(active + 1, lis.length - 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { onPick(lis[active].dataset.coach); return; }
    else if (e.key === "Escape") { list.hidden = true; return; }
    else return;
    lis.forEach((li, i) => li.classList.toggle("active", i === active));
    if (lis[active]) lis[active].scrollIntoView({ block: "nearest" });
  });
}

function wireUI() {
  wireCombo("#coach-input", "#coach-list", pickCoach);
  wireCombo("#compare-input", "#compare-list", setCompare);
  // Clearing the compare box by hand should drop back to the single-coach view.
  $("#compare-input").addEventListener("change", () => {
    if (!$("#compare-input").value.trim() && compareCoach) setCompare(null);
  });

  document.querySelectorAll(".seg").forEach((seg) => {
    const group = seg.dataset.group;
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      setSeg(group, b.dataset.val); state[group] = b.dataset.val; onFilterChange();
    }));
  });

  ["#thr", "#tthr", "#min", "#loc", "#spread", "#opp", "#oppcoach", "#y1", "#y2"].forEach((sel) => {
    const el = $(sel);
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", onFilterChange);
  });

  $("#home").href = ROOT;
  $("#home").addEventListener("click", goHome);
  // "← All coaches" back link is re-rendered inside #results; delegate it.
  $("#results").addEventListener("click", (e) => {
    if (e.target.closest("a.back")) goHome(e);
  });
}

initSqlJs === undefined ? null : init();
