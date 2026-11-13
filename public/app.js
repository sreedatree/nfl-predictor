// Build DOM with textContent only (no innerHTML) so API data can never inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);
const weekSel = $("week");
const statusEl = $("status");

// Regular season weeks 1-18 and the playoff rounds (ESPN numbers the Super Bowl as week 5).
const WEEKS = [
  ...Array.from({ length: 18 }, (_, i) => ({ type: 2, week: i + 1, label: `Week ${i + 1}` })),
  { type: 3, week: 1, label: "Wild Card" },
  { type: 3, week: 2, label: "Divisional" },
  { type: 3, week: 3, label: "Conference Championships" },
  { type: 3, week: 5, label: "Super Bowl" },
];

for (const w of WEEKS) weekSel.append(h("option", { value: `${w.type}:${w.week}` }, w.label));

const fmt = (v, suffix = "") => (v == null ? "–" : `${v}${suffix}`);
const signed = (v) => (v == null ? "–" : v > 0 ? `+${v}` : `${v}`);
const cls = (v) => (v > 0 ? "num-pos" : v < 0 ? "num-neg" : "");

async function load(type, week) {
  statusEl.className = "status";
  statusEl.textContent = "Loading games… (the first load can take a minute while stats are downloaded)";
  $("games").replaceChildren();
  const q = new URLSearchParams();
  if (type) q.set("seasonType", type);
  if (week) q.set("week", week);
  try {
    // Relative URL so it also works when the app is served under a path prefix / proxy.
    const res = await fetch(`api/predictions?${q}`);
    const body = await res.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`The server did not return data (HTTP ${res.status}: "${body.slice(0, 80)}"). Make sure the page is opened from the predictor server, e.g. http://localhost:3000`);
    }
    if (!res.ok) throw new Error(data.error || "Request failed");
    render(data);
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = err.message;
  }
}

function render(data) {
  weekSel.value = `${data.seasonType}:${data.week}`;
  statusEl.textContent = data.games.length ? "" : "No games scheduled for this week.";

  const acc = data.accuracy;
  const wr = data.weekRecord;
  $("summary").replaceChildren(
    pill(`${data.season}`, "Season"),
    acc.accuracy != null ? pill(`${acc.accuracy}%`, `Pick accuracy (${acc.correct}/${acc.games} games, pre-game picks)`) : null,
    acc.compare && acc.compare.games
      ? pill(`${acc.compare.model}% / ${acc.compare.market}% / ${acc.compare.blended}%`, `Model / betting line / blended, ${acc.compare.games} games with lines`)
      : null,
    wr.decided ? pill(`${wr.correct}/${wr.decided}`, "Correct this week") : null
  );

  $("games").replaceChildren(...data.games.map(gameCard));
}

const pill = (big, small) => h("div", { class: "pill" }, h("b", {}, big), h("span", {}, small));

function teamBlock(side, isHome, pickId, showScore) {
  const t = side.team;
  return h(
    "div",
    { class: `team ${isHome ? "home" : "away"} ${t.id === pickId ? "pick" : ""}` },
    t.logo ? h("img", { src: t.logo, alt: "", loading: "lazy" }) : null,
    h("div", {}, h("div", { class: "nm" }, t.name), h("div", { class: "rec" }, `${side.stats.record} · ${isHome ? "Home" : "Away"}`)),
    showScore ? h("div", { class: "pts" }, side.score) : null
  );
}

function gameCard(g) {
  const p = g.prediction;
  const pickId = p.winnerId;
  const started = g.status.state !== "pre";
  const when = new Date(g.date).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  let badge = null;
  if (g.correct === true) badge = h("span", { class: "badge ok" }, "Correct pick");
  else if (g.correct === false) badge = h("span", { class: "badge miss" }, "Missed");
  else if (g.status.state === "in") badge = h("span", { class: "badge live" }, g.status.detail || "Live");

  const pickTeam = pickId === g.home.team.id ? g.home.team : g.away.team;
  const pWin = Math.max(p.homeWinProb, p.awayWinProb);
  const awayCol = g.away.team.color, homeCol = g.home.team.color;

  return h(
    "article",
    { class: "game" },
    h("div", { class: "meta" }, h("span", {}, `${when}${g.venue ? " · " + g.venue : ""}`), h("span", {}, g.status.state === "post" ? "Final" : "", " ", badge)),
    h(
      "div",
      { class: "matchup" },
      teamBlock(g.away, false, pickId, started),
      h("div", { class: "vs" }, "at"),
      teamBlock(g.home, true, pickId, started)
    ),
    h(
      "div",
      { class: "bar", role: "img", "aria-label": `${g.away.team.short} ${p.awayWinProb}% , ${g.home.team.short} ${p.homeWinProb}%` },
      h("div", { style: `width:${p.awayWinProb}%;background:${awayCol}` }),
      h("div", { style: `width:${p.homeWinProb}%;background:${homeCol}` })
    ),
    h("div", { class: "probs" }, h("span", {}, `${g.away.team.abbr} ${p.awayWinProb}%`), h("span", {}, `${p.homeWinProb}% ${g.home.team.abbr}`)),
    h(
      "div",
      { class: "pred" },
      h("span", {}, h("strong", {}, `Pick: ${pickTeam.name}`), ` (${pWin}%)`),
      h("span", { class: "conf" }, `${p.confidence} · projected ${g.away.team.abbr} ${p.predictedScore.away}, ${g.home.team.abbr} ${p.predictedScore.home}`)
    ),
    lineRow(g),
    h("details", {}, h("summary", {}, "Lineups, injuries and analysis"), lineupsSection(g), statsTable(g), factorsTable(g), h2h(g))
  );
}

const mlFmt = (v) => (v == null ? "–" : v > 0 ? `+${v}` : `${v}`);

// Betting line vs. the model's own opinion.
function lineRow(g) {
  const p = g.prediction;
  const m = p.market;
  if (!m) return h("p", { class: "line muted" }, "No betting line posted yet; pick is from the model only.");
  const home = g.home.team.abbr;
  const away = g.away.team.abbr;
  const name = (sp) => (sp === 0 ? "pick'em" : `${sp > 0 ? home : away} by ${Math.abs(sp).toFixed(1)}`);
  const gap = Math.abs(p.modelOnly.spread - m.spread);
  return h(
    "div",
    { class: "line" },
    h(
      "span",
      {},
      h("strong", {}, "Line: "),
      `${m.line}${m.total != null ? ` · O/U ${m.total}` : ""} · ML ${away} ${mlFmt(m.awayML)} / ${home} ${mlFmt(m.homeML)}`,
      m.provider ? ` (${m.provider})` : ""
    ),
    h(
      "span",
      { class: gap >= 3 ? "diverge" : "muted" },
      `Model alone: ${name(p.modelOnly.spread)}${gap >= 3 ? ` · ${gap.toFixed(1)} pts away from the line` : ""}`
    )
  );
}

const STATUS_TAG = (st) => {
  const s = String(st ?? "").toLowerCase();
  if (!s || s === "active") return null;
  if (s.includes("reserve") || s === "ir") return ["IR", "out"];
  if (s.includes("out") || s.includes("pup") || s.includes("suspen")) return ["OUT", "out"];
  if (s.includes("doubtful")) return ["D", "doubt"];
  if (s.includes("question")) return ["Q", "ques"];
  return [st, "ques"];
};
const tag = (st) => {
  const t = STATUS_TAG(st);
  return t ? h("span", { class: `tag ${t[1]}`, title: st }, t[0]) : null;
};

const OFFENSE_ORDER = ["qb", "rb", "fb", "wr1", "wr2", "wr3", "te", "lt", "lg", "c", "rg", "rt"];

function lineupList(title, slots, order) {
  const sorted = order ? [...slots].sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot)) : slots;
  return h(
    "div",
    {},
    h("h4", {}, title),
    h(
      "ul",
      { class: "lineup" },
      sorted.map((s) =>
        h(
          "li",
          {},
          h("span", { class: "slot" }, s.label),
          h("span", {}, s.starter.name, " ", tag(s.starter.status)),
          s.expected ? h("span", { class: "repl", title: "Expected replacement" }, `→ ${s.expected.name}`) : null
        )
      )
    )
  );
}

function teamLineup(team, l) {
  const sig = l.injuries.filter((i) => i.inLineup);
  return h(
    "div",
    { class: "lineup-col" },
    h("h3", {}, `${team.name}${l.impact.points > 0 ? ` · injury cost ~${l.impact.points} pts` : ""}`),
    lineupList("Offense", l.offense, OFFENSE_ORDER),
    lineupList("Defense", l.defense),
    lineupList("Kicker / punter", l.special),
    h(
      "div",
      {},
      h("h4", {}, "Injury report"),
      sig.length || l.injuries.length
        ? h(
            "ul",
            { class: "inj" },
            (sig.length ? sig : l.injuries.slice(0, 6)).map((i) =>
              h("li", { title: i.comment || null }, h("strong", {}, i.name), ` ${i.pos} `, tag(i.status), i.detail ? ` ${i.detail}` : "", i.returnDate ? ` · est. return ${i.returnDate}` : "")
            )
          )
        : h("p", { class: "muted" }, "No injuries reported.")
    )
  );
}

function lineupsSection(g) {
  if (!g.lineup) {
    return h("p", { class: "muted" }, g.status.state === "post" ? "Lineups and injuries are shown for upcoming games only. This pick was made before kickoff without injury data." : "Lineup data not available.");
  }
  return h(
    "div",
    {},
    h("h3", {}, "Expected starting lineups"),
    h("p", { class: "muted" }, "Depth chart starters from ESPN. OUT/IR/D/Q = Out or injured reserve / Doubtful / Questionable. An arrow shows the expected replacement."),
    h("div", { class: "lineups" }, teamLineup(g.away.team, g.lineup.away), teamLineup(g.home.team, g.lineup.home))
  );
}

// One row per stat, home and away values side by side.
const STAT_ROWS = [
  ["Record", (s) => s.record],
  ["Elo rating", (s) => s.elo],
  ["Points per game", (s) => fmt(s.ppg)],
  ["Points allowed / game", (s) => fmt(s.papg)],
  ["Yards per game", (s) => fmt(s.ypg)],
  ["Yards allowed / game", (s) => fmt(s.ypgAllowed)],
  ["Yards per play", (s) => fmt(s.ypp)],
  ["Time of possession", (s) => fmt(s.possession)],
  ["3rd down %", (s) => fmt(s.thirdDownPct, "%")],
  ["Total defensive sacks", (s) => fmt(s.sacks)],
  ["Total defensive INTs", (s) => fmt(s.interceptions)],
  ["Takeaways / giveaways", (s) => (s.takeaways == null ? "–" : `${s.takeaways} / ${s.giveaways}`)],
  ["Total turnover differential", (s) => h("span", { class: cls(s.turnoverDiff) }, signed(s.turnoverDiff))],
  ["Avg margin", (s) => h("span", { class: cls(s.margin) }, signed(s.margin))],
  ["Last 5", (s) => h("span", { class: "form" }, s.last5.map((r) => h("span", { class: r }, r)))],
];

function statsTable(g) {
  return h(
    "div",
    {},
    h("h3", {}, "Season stats"),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, g.away.team.abbr), h("th", { scope: "col" }, "Stat"), h("th", { scope: "col" }, g.home.team.abbr))),
      h("tbody", {}, STAT_ROWS.map(([label, f]) => h("tr", {}, h("td", {}, f(g.away.stats)), h("td", { class: "lbl" }, label), h("td", {}, f(g.home.stats)))))
    )
  );
}

function factorsTable(g) {
  const home = g.home.team.abbr;
  return h(
    "div",
    {},
    h("h3", {}, `What drove the pick (points in favor of ${home}, negative favors ${g.away.team.abbr})`),
    h(
      "table",
      { class: "factors" },
      h("tbody", {}, g.prediction.factors.map((f) => h("tr", {}, h("td", {}, f.label), h("td", {}, f.detail), h("td", { class: cls(f.points) }, signed(f.points))))),
      h("tfoot", {}, h("tr", {}, h("td", {}, h("strong", {}, "Predicted spread")), h("td", {}), h("td", { class: cls(g.prediction.spread) }, signed(g.prediction.spread))))
    )
  );
}

function h2h(g) {
  const list = g.prediction.headToHead;
  const abbr = (id) => (id === g.home.team.id ? g.home.team.abbr : g.away.team.abbr);
  return h(
    "div",
    {},
    h("h3", {}, "Recent head-to-head"),
    list.length
      ? h(
          "table",
          {},
          h("tbody", {}, list.map((m) => h("tr", {}, h("td", {}, `${m.season}${m.week ? " wk " + m.week : ""}`), h("td", {}, `${abbr(m.awayId)} ${m.awayScore}`), h("td", {}, `${abbr(m.homeId)} ${m.homeScore}`))))
        )
      : h("p", { class: "status" }, "No meetings in the last 3 seasons.")
  );
}

weekSel.addEventListener("change", () => {
  const [type, week] = weekSel.value.split(":");
  load(type, week);
});

load();
