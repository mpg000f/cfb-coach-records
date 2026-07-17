"use strict";

let db = null;
let coaches = [];       // {coach, first_year, last_year, ranked_games}
let selectedCoach = null;
const state = { poll: "ap", timing: "game" };

const $ = (s) => document.querySelector(s);

async function init() {
  const results = $("#results");
  results.innerHTML = '<p class="loading">Loading database…</p>';
  try {
    const SQL = await initSqlJs({ locateFile: (f) => "vendor/" + f });
    const buf = await fetch("data/coaches.db").then((r) => r.arrayBuffer());
    db = new SQL.Database(new Uint8Array(buf));
    coaches = rows("SELECT coach, first_year, last_year, ranked_games FROM coaches");
    wireUI();
    renderLeaderboard();
  } catch (e) {
    results.innerHTML = '<p class="empty">Could not load the database. ' + e.message + "</p>";
  }
}

// --- tiny query helpers -------------------------------------------------
function rows(sql, params) {
  const st = db.prepare(sql);
  if (params) st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}

// --- filter reads -------------------------------------------------------
function rankCols() {
  const poll = state.poll === "coaches" ? "coaches" : "ap";
  const timing = state.timing === "final" ? "final" : "game";
  return { opp: `opp_${poll}_${timing}`, team: `team_${poll}_${timing}` };
}

function currentFilters() {
  return {
    thr: parseInt($("#thr").value, 10),
    both: $("#both").checked,
    loc: $("#loc").value,
    opp: $("#opp").value.trim(),
    y1: parseInt($("#y1").value, 10) || 1936,
    y2: parseInt($("#y2").value, 10) || 2025,
  };
}

// Build the shared WHERE clause + params for the selected coach & filters.
function buildQuery(select, coach) {
  const c = rankCols();
  const f = currentFilters();
  const where = [`coach = $coach`, `${c.opp} BETWEEN 1 AND $thr`,
    `season BETWEEN $y1 AND $y2`];
  const p = { $coach: coach, $thr: f.thr, $y1: f.y1, $y2: f.y2 };
  if (f.both) where.push(`${c.team} BETWEEN 1 AND $thr`);
  if (f.loc === "neutral") where.push(`neutral = 1`);
  else if (f.loc === "home") where.push(`home = 1 AND neutral = 0`);
  else if (f.loc === "away") where.push(`home = 0 AND neutral = 0`);
  if (f.opp) { where.push(`opponent LIKE $opp`); p.$opp = "%" + f.opp + "%"; }
  return {
    sql: select.replace("{team_rank}", c.team).replace("{opp_rank}", c.opp)
      + " WHERE " + where.join(" AND "),
    params: p,
  };
}

// --- rendering ----------------------------------------------------------
function renderCoach() {
  if (!selectedCoach) return;
  const q = buildQuery(
    `SELECT season, week, season_type, team, opponent, team_pts, opp_pts, result,
            neutral, home, {team_rank} AS tr, {opp_rank} AS orr FROM games`,
    selectedCoach);
  const g = rows(q.sql + " ORDER BY season, week", q.params);

  let w = 0, l = 0, t = 0;
  for (const r of g) { if (r.result === "W") w++; else if (r.result === "L") l++; else t++; }
  const pct = w + l ? (w / (w + l)) : 0;

  const c = coaches.find((x) => x.coach === selectedCoach);
  $("#summary").hidden = false;
  $("#summary").innerHTML = stat(`${w}–${l}${t ? "–" + t : ""}`, "Record")
    + stat((pct * 100).toFixed(1) + "%", "Win %")
    + stat(g.length, "Games")
    + stat(c ? c.first_year + "–" + c.last_year : "—", "Span");

  const label = filterLabel();
  if (!g.length) {
    $("#results").innerHTML = `<p class="sect-title">${esc(selectedCoach)} — ${label}</p>`
      + '<p class="empty">No games match these filters.</p>';
    return;
  }
  const body = g.map((r) => {
    const loc = r.neutral ? "N" : (r.home ? "vs" : "at");
    return `<tr>
      <td class="num">${r.season}</td>
      <td>${loc} ${esc(r.opponent)}</td>
      <td class="num">${rk(r.orr)}</td>
      <td class="num">${rk(r.tr)}</td>
      <td class="num">${r.team_pts}–${r.opp_pts}</td>
      <td class="res ${r.result}">${r.result}</td>
      <td>${r.season_type === "postseason" ? "Bowl/CFP" : "Wk " + r.week}</td>
    </tr>`;
  }).join("");
  $("#results").innerHTML = `<p class="sect-title">${esc(selectedCoach)} — ${label}</p>
    <div class="table-scroll"><table>
      <thead><tr><th>Season</th><th>Opponent</th><th>Opp rank</th><th>Team rank</th>
      <th>Score</th><th>Res</th><th>When</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

function filterLabel() {
  const f = currentFilters();
  const poll = state.poll === "coaches" ? "Coaches" : "AP";
  const timing = state.timing === "final" ? "final" : "at kickoff";
  const base = f.both ? `both teams Top ${f.thr}` : `vs Top ${f.thr}`;
  return `${base} (${poll}, ${timing})`;
}

// Landing view: best coaches under the current filters.
function renderLeaderboard() {
  const c = rankCols();
  const f = currentFilters();
  const both = f.both ? `AND ${c.team} BETWEEN 1 AND ${f.thr}` : "";
  const board = rows(
    `SELECT coach,
       SUM(result='W') AS w, SUM(result='L') AS l, SUM(result='T') AS t
     FROM games
     WHERE ${c.opp} BETWEEN 1 AND ${f.thr} AND season BETWEEN ${f.y1} AND ${f.y2} ${both}
     GROUP BY coach
     HAVING (w + l) >= 10
     ORDER BY (w * 1.0 / (w + l)) DESC, w DESC
     LIMIT 25`);
  $("#summary").hidden = true;
  const body = board.map((r, i) => {
    const pct = (r.w / (r.w + r.l) * 100).toFixed(1);
    return `<tr>
      <td class="num">${i + 1}</td>
      <td class="lead-name" data-coach="${esc(r.coach)}">${esc(r.coach)}</td>
      <td class="num">${r.w}–${r.l}${r.t ? "–" + r.t : ""}</td>
      <td class="num">${pct}%</td></tr>`;
  }).join("");
  $("#results").innerHTML = `<p class="sect-title">Leaderboard — ${filterLabel()} · min 10 games</p>
    <div class="table-scroll"><table>
      <thead><tr><th>#</th><th>Coach</th><th>Record</th><th>Win %</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  $("#results").querySelectorAll(".lead-name").forEach((el) =>
    el.addEventListener("click", () => pickCoach(el.dataset.coach)));
}

function refresh() { selectedCoach ? renderCoach() : renderLeaderboard(); }

const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
const rk = (n) => n ? `<span class="rk">#${n}</span>` : "—";
const esc = (s) => String(s).replace(/[&<>"]/g, (m) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

// --- UI wiring ----------------------------------------------------------
function pickCoach(name) {
  selectedCoach = name;
  $("#coach-input").value = name;
  $("#coach-list").hidden = true;
  renderCoach();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function wireUI() {
  const input = $("#coach-input");
  const list = $("#coach-list");
  let active = -1;

  const showList = () => {
    const q = input.value.trim().toLowerCase();
    const items = (q
      ? coaches.filter((c) => c.coach.toLowerCase().includes(q))
      : coaches).slice(0, 40);
    active = -1;
    if (!items.length) { list.hidden = true; return; }
    list.innerHTML = items.map((c) =>
      `<li role="option" data-coach="${esc(c.coach)}">
        <span class="cn">${esc(c.coach)}</span>
        <span class="cm">${c.first_year}–${c.last_year} · ${c.ranked_games} ranked</span>
      </li>`).join("");
    list.hidden = false;
    list.querySelectorAll("li").forEach((li) =>
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pickCoach(li.dataset.coach); }));
  };

  input.addEventListener("input", showList);
  input.addEventListener("focus", showList);
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    const lis = [...list.querySelectorAll("li")];
    if (e.key === "ArrowDown") { active = Math.min(active + 1, lis.length - 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { pickCoach(lis[active].dataset.coach); return; }
    else if (e.key === "Escape") { list.hidden = true; return; }
    else return;
    lis.forEach((li, i) => li.classList.toggle("active", i === active));
    if (lis[active]) lis[active].scrollIntoView({ block: "nearest" });
  });

  // Segmented toggles (poll, timing)
  document.querySelectorAll(".seg").forEach((seg) => {
    const group = seg.dataset.group;
    seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state[group] = b.dataset.val;
      refresh();
    }));
  });

  ["#thr", "#both", "#loc", "#opp", "#y1", "#y2"].forEach((sel) => {
    const el = $(sel);
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", refresh);
  });
}

initSqlJs === undefined ? null : init();
