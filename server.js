const path = require("path");
const express = require("express");
const espn = require("./src/espn");
const { Model } = require("./src/model");
const { buildTeamLineup } = require("./src/lineup");

const PORT = process.env.PORT || 3000;
const SEASONS_BACK = 2; // current season + 2 prior seasons feed the model
const MODEL_TTL_MS = 10 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ---- model cache ---------------------------------------------------------
let modelCache = null; // { at, season, teams, games, model }
let modelBuilding = null;

async function currentSeasonFromScoreboard() {
  const sb = await espn.getScoreboard();
  return { season: sb.leagues?.[0]?.season?.year ?? new Date().getFullYear(), sb };
}

async function getModel() {
  if (modelCache && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache;
  if (!modelBuilding) {
    modelBuilding = (async () => {
      const [teams, { season }] = await Promise.all([espn.getTeams(), currentSeasonFromScoreboard()]);
      const seasons = Array.from({ length: SEASONS_BACK + 1 }, (_, i) => season - SEASONS_BACK + i);
      const games = await espn.getGames(teams, seasons);
      // Box-score stats and closing lines for the current and previous season (older seasons only feed Elo).
      await espn.attachGameData(games, season - 1);
      const model = new Model(games, teams);
      modelCache = { at: Date.now(), season, teams, games, model };
      return modelCache;
    })().finally(() => {
      modelBuilding = null;
    });
  }
  return modelBuilding;
}

// ---- helpers -------------------------------------------------------------
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

async function buildGame(ev, ctx, season, injuries) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  const state = ev.status?.type?.state ?? "pre"; // pre | in | post
  const homeId = String(home.id);
  const awayId = String(away.id);
  const date = new Date(ev.date).getTime();
  const neutral = !!comp.neutralSite;

  const completed = state === "post";
  const score = (c) => (state === "pre" ? null : Number(c.score));
  const homeScore = score(home);
  const awayScore = score(away);

  let prediction;
  let lineup = null;
  if (completed && ctx.model.pre.get(String(ev.id))) {
    // Finished game: show the pick that was made before kickoff (no hindsight).
    prediction = ctx.model.pre.get(String(ev.id));
  } else if (state === "pre") {
    // Upcoming game: add the current betting line and the injury-adjusted lineups.
    const [odds, homeDepth, awayDepth] = await Promise.all([espn.getEventOdds(String(ev.id)), espn.getDepthChart(homeId), espn.getDepthChart(awayId)]);
    const hl = buildTeamLineup(homeDepth, injuries.get(homeId));
    const al = buildTeamLineup(awayDepth, injuries.get(awayId));
    lineup = { home: hl, away: al };
    const ab = (id) => ctx.teamsById.get(id)?.abbr ?? id;
    const who = (l) => l.impact.items.slice(0, 2).map((i) => `${i.name} (${i.slot}, ${i.status})`).join(", ");
    const parts = [];
    if (hl.impact.points > 0) parts.push(`${ab(homeId)} -${hl.impact.points}: ${who(hl)}`);
    if (al.impact.points > 0) parts.push(`${ab(awayId)} -${al.impact.points}: ${who(al)}`);
    prediction = ctx.model.predict({
      homeId, awayId, season, date, neutral,
      odds,
      injuries: { homeHarm: hl.impact.points, awayHarm: al.impact.points, detail: parts.join("; ") },
    });
  } else {
    prediction = ctx.model.predict({ homeId, awayId, season, date, neutral });
  }

  let correct = null;
  if (completed && homeScore !== awayScore) {
    correct = prediction.winnerId === (homeScore > awayScore ? homeId : awayId);
  }

  const side = (c, id, pts) => ({
    team: ctx.teamsById.get(id),
    score: pts,
    stats: ctx.model.teamStats(id, season),
  });

  return {
    id: String(ev.id),
    date: ev.date,
    name: ev.shortName,
    venue: comp.venue?.fullName ?? null,
    neutral,
    status: { state, detail: ev.status?.type?.shortDetail ?? "" },
    home: side(home, homeId, homeScore),
    away: side(away, awayId, awayScore),
    prediction,
    lineup,
    correct,
  };
}

// ---- API -----------------------------------------------------------------
app.get("/api/predictions", async (req, res) => {
  try {
    const ctx = await getModel();
    ctx.teamsById = new Map(ctx.teams.map((t) => [t.id, t]));

    const { sb } = await currentSeasonFromScoreboard();
    const season = toInt(req.query.season) ?? ctx.season;
    const seasonType = toInt(req.query.seasonType) ?? sb.season?.type ?? 2;
    const week = toInt(req.query.week) ?? sb.week?.number ?? 1;

    const board = await espn.getScoreboard(season, seasonType, week);
    const events = (board.events ?? []).filter((e) => e.competitions?.[0]?.competitors?.length === 2);
    // The injury report is league-wide; if it is down, fall back to no injury data.
    const injuries = await espn.getInjuries().catch((err) => {
      console.warn("Injury report unavailable:", err.message);
      return new Map();
    });
    const built = await espn.pool(events, 6, (e) => buildGame(e, ctx, season, injuries));
    const games = built.sort((a, b) => new Date(a.date) - new Date(b.date));

    const decided = games.filter((g) => g.correct !== null);
    res.json({
      season,
      seasonType,
      week: board.week?.number ?? week,
      defaultWeek: sb.week?.number ?? null,
      games,
      weekRecord: { correct: decided.filter((g) => g.correct).length, decided: decided.length },
      accuracy: ctx.model.accuracy(ctx.games),
      updatedAt: new Date(ctx.at).toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not load NFL data. Please try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`NFL predictor running at http://localhost:${PORT}`);
  getModel().then(
    (c) => console.log(`Model ready: ${c.games.length} games loaded`),
    (e) => console.error("Initial model build failed:", e.message)
  );
});
