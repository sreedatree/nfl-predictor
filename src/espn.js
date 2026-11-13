// Thin client for ESPN's public (unauthenticated) NFL endpoints, with in-memory caching.
const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // url -> { at, data }
const inflight = new Map(); // url -> Promise

async function getJson(url, ttl = TTL_MS) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
        const data = await res.json();
        cache.set(url, { at: Date.now(), data });
        return data;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    // Serve stale data if we have it rather than failing outright.
    if (hit) return hit.data;
    throw lastErr;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}

// Run async tasks with a concurrency cap so we don't hammer ESPN.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getTeams() {
  const data = await getJson(`${BASE}/teams?limit=40`, 24 * 60 * 60 * 1000);
  const list = data.sports[0].leagues[0].teams.map((t) => t.team);
  return list.map((t) => ({
    id: String(t.id),
    abbr: t.abbreviation,
    name: t.displayName,
    short: t.shortDisplayName,
    color: t.color ? `#${t.color}` : "#555555",
    logo: t.logos?.[0]?.href ?? null,
  }));
}

// Normalise one ESPN schedule event into a flat game record.
function parseEvent(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  if (!home || !away) return null;
  const completed = !!comp.status?.type?.completed;
  const score = (c) => (c.score?.value ?? Number(c.score?.displayValue ?? NaN));
  return {
    id: String(ev.id),
    date: new Date(ev.date).getTime(),
    season: ev.season?.year,
    seasonType: Number(ev.seasonType?.id ?? ev.seasonType?.type ?? 2),
    week: ev.week?.number ?? null,
    neutral: !!comp.neutralSite,
    completed,
    homeId: String(home.id),
    awayId: String(away.id),
    homeScore: completed ? score(home) : null,
    awayScore: completed ? score(away) : null,
  };
}

async function getTeamSchedule(teamId, season, seasonType) {
  const url = `${BASE}/teams/${teamId}/schedule?season=${season}&seasontype=${seasonType}`;
  try {
    const data = await getJson(url);
    return (data.events ?? []).map(parseEvent).filter(Boolean);
  } catch {
    return []; // a missing season/type should not take the whole app down
  }
}

// All games (deduped by event id) for the given seasons, regular season + playoffs.
async function getGames(teams, seasons) {
  const jobs = [];
  for (const t of teams) for (const s of seasons) for (const type of [2, 3]) jobs.push([t.id, s, type]);
  const lists = await pool(jobs, 8, ([id, s, type]) => getTeamSchedule(id, s, type));
  const byId = new Map();
  for (const g of lists.flat()) if (!byId.has(g.id)) byId.set(g.id, g);
  return [...byId.values()].sort((a, b) => a.date - b.date);
}

// ---- per-game data: box scores + closing betting lines ------------------------
// Per-game team stats (yards, possession, sacks, turnovers...) and the closing line.
// Finished games never change, so they are cached on disk and only fetched once.
const fs = require("fs");
const path = require("path");
const BOX_FILE = path.join(__dirname, "..", ".cache", "gamedata.json");
let boxStore = null; // eventId -> { box: { [teamId]: stats } | null, odds: {...} | null }

function loadBoxStore() {
  if (boxStore) return boxStore;
  try {
    boxStore = JSON.parse(fs.readFileSync(BOX_FILE, "utf8"));
  } catch {
    boxStore = {};
  }
  return boxStore;
}

function saveBoxStore() {
  try {
    fs.mkdirSync(path.dirname(BOX_FILE), { recursive: true });
    fs.writeFileSync(BOX_FILE, JSON.stringify(boxStore));
  } catch (err) {
    console.warn("Could not write box score cache:", err.message);
  }
}

const pair = (s) => {
  const m = /^(\d+)\D+(\d+)$/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

function parseTeamBox(t) {
  const m = new Map((t.statistics ?? []).map((s) => [s.name, s.displayValue])); // first occurrence wins
  const num = (k) => Number(String(m.get(k) ?? "").replace(/,/g, "")) || 0;
  const [mm, ss] = String(m.get("possessionTime") ?? "0:0").split(":").map(Number);
  const [thirdConv, thirdAtt] = pair(m.get("thirdDownEff"));
  return {
    yards: num("totalYards"),
    passYards: num("netPassingYards"),
    rushYards: num("rushingYards"),
    plays: num("totalOffensivePlays"),
    ypp: num("yardsPerPlay"),
    possSec: (mm || 0) * 60 + (ss || 0),
    turnovers: num("turnovers"),
    ints: num("interceptions"), // thrown by this team
    sacksTaken: pair(m.get("sacksYardsLost"))[0],
    thirdConv,
    thirdAtt,
    firstDowns: num("firstDowns"),
  };
}

// ESPN's `spread` is the HOME team's line: negative means the home team is favoured.
function parseOdds(p) {
  if (!p) return null;
  const n = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const spread = n(p.spread);
  if (spread == null) return null;
  return {
    provider: p.provider?.name ?? null,
    spread, // home line (negative = home favoured)
    total: n(p.overUnder),
    homeML: n(p.homeTeamOdds?.moneyLine),
    awayML: n(p.awayTeamOdds?.moneyLine),
    details: p.details ?? null,
  };
}

async function fetchGameData(eventId, ttl = 1000) {
  const data = await getJson(`${BASE}/summary?event=${eventId}`, ttl);
  let box = null;
  const teams = data.boxscore?.teams ?? [];
  if (teams.length === 2) {
    box = {};
    for (const t of teams) box[String(t.team.id)] = parseTeamBox(t);
    // Treat an empty box score (no yards for either side) as missing.
    if (Object.values(box).every((s) => s.yards === 0)) box = null;
  }
  return { box, odds: parseOdds(data.pickcenter?.[0]) };
}

// Attach `box` ({homeId: stats, awayId: stats}) and `odds` to completed games from `minSeason` on.
async function attachGameData(games, minSeason) {
  const store = loadBoxStore();
  const todo = games.filter((g) => g.completed && g.season >= minSeason && !(g.id in store));
  if (todo.length) console.log(`Fetching ${todo.length} box scores and lines...`);
  let done = 0;
  await pool(todo, 8, async (g) => {
    try {
      store[g.id] = await fetchGameData(g.id);
    } catch {
      return; // leave uncached; retried on the next refresh
    }
    if (++done % 100 === 0) saveBoxStore();
  });
  if (todo.length) saveBoxStore();
  for (const g of games) {
    g.box = store[g.id]?.box ?? null;
    g.odds = store[g.id]?.odds ?? null;
  }
  return games;
}

// Current betting line for an upcoming game (lines move, so cache briefly).
async function getEventOdds(eventId) {
  try {
    return (await fetchGameData(eventId, 5 * 60 * 1000)).odds;
  } catch {
    return null;
  }
}

// ---- injuries and depth charts ---------------------------------------------------
// League-wide injury report -> Map(teamId -> [{ name, pos, status, detail, comment, date, returnDate }])
async function getInjuries() {
  const data = await getJson(`${BASE}/injuries`, 10 * 60 * 1000);
  const byTeam = new Map();
  for (const t of data.injuries ?? []) {
    byTeam.set(
      String(t.id),
      (t.injuries ?? [])
        .filter((i) => i.athlete?.displayName)
        .map((i) => ({
          name: i.athlete.displayName,
          pos: i.athlete.position?.abbreviation ?? "",
          status: i.status ?? "",
          detail: i.details?.detail ?? i.details?.type ?? "",
          returnDate: i.details?.returnDate ?? null,
          comment: i.shortComment ?? "",
          date: i.date ? new Date(i.date).getTime() : null,
        }))
    );
  }
  return byTeam;
}

// Depth chart -> { offense: [{slot, players:[names]}], defense: [...], special: [...] }
async function getDepthChart(teamId) {
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/depthcharts`;
  try {
    const data = await getJson(url, 30 * 60 * 1000);
    const out = { offense: [], defense: [], special: [] };
    for (const f of data.depthchart ?? []) {
      const slots = Object.keys(f.positions ?? {});
      const group = slots.includes("qb") ? "offense" : slots.includes("pk") ? "special" : "defense";
      out[group] = slots.map((slot) => ({
        slot,
        players: (f.positions[slot].athletes ?? []).map((a) => ({ id: String(a.id), name: a.displayName })),
      }));
    }
    return out;
  } catch {
    return null;
  }
}

async function getScoreboard(season, seasonType, week) {
  const q = new URLSearchParams();
  if (season) q.set("dates", String(season));
  if (seasonType) q.set("seasontype", String(seasonType));
  if (week) q.set("week", String(week));
  return getJson(`${BASE}/scoreboard?${q}`, 60 * 1000);
}

module.exports = { getTeams, getGames, getScoreboard, attachGameData, getEventOdds, getInjuries, getDepthChart, pool };
