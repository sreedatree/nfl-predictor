// Prediction model: Elo ratings (with margin-of-victory) adjusted by current-season
// stats, recent form, head-to-head history and rest. Everything is expressed as a
// point spread from the home team's perspective, then converted to a win probability.

const START_ELO = 1500;
const K = 20;
const HOME_ELO = 50; // ~2 points of home-field advantage
const ELO_PER_POINT = 25; // ~25 Elo points per point of spread
const SEASON_REGRESSION = 1 / 3; // pull ratings toward the mean each new season
const LEAGUE_AVG_PPG = 22.5;

const WEIGHTS = {
  seasonMargin: 0.2, // pts of spread per pt of avg-margin difference
  form: 0.08, // last-4-games margin difference
  h2h: 0.15, // avg margin in recent head-to-head meetings
  h2hCap: 2.5,
  rest: 0.1, // per day of rest advantage
  restCap: 1,
  // Box-score based matchup factors (pts of spread per unit of matchup difference)
  yards: 0.01, // per yard/game of net-yardage matchup edge
  ypp: 0.75, // per yard/play of net efficiency edge
  possession: 0.08, // per minute/game of possession edge
  possessionCap: 0.75,
  sacks: 0.4, // per sack/game of pass-rush vs protection edge
  sacksCap: 1.5,
  ints: 0.5, // per interception/game of ball-hawk vs. ball-security edge
  intsCap: 1.5,
  turnovers: 0.15, // per turnover/game of turnover-margin edge
  turnoversCap: 1.5,
};
// Weights were tuned by backtesting on 2025-26 results; box-score factors overlap with Elo
// and point differential, so they are deliberately small to avoid double counting.
const BOX_SCALE = 1;
// Share of the final spread taken from the betting line when one is available. The line
// already prices in injuries and lineups, so the model's own view is blended in, not stacked.
// Backtest (241 games with lines, 2025-26): the line alone beats the model alone on margin
// error (9.7 vs 10.2 pts); 0.7 gave the best pick accuracy, and 0.7-1.0 are statistically tied.
const MARKET_WEIGHT = 0.7;
// The raw factor sum is overconfident: regressing actual margins on it gives a slope of ~0.7
// (2025-26 backtest, 422 games). Shrinking it toward zero lowers error and fixes calibration.
const MODEL_SHRINK = 0.7;
const INJURY_SCALE = 1; // multiplier on the heuristic injury-impact points (see lineup.js)
const BOX_WINDOW = 10; // most recent games with box scores used for matchup factors
const BOX_PRIOR = 3; // pseudo-games of league average mixed into each team's averages

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const round1 = (x) => Math.round(x * 10) / 10;

class Model {
  constructor(games, teams) {
    this.teams = new Map(teams.map((t) => [t.id, t]));
    this.elo = new Map(teams.map((t) => [t.id, START_ELO]));
    this.history = new Map(teams.map((t) => [t.id, []]));
    this.h2h = new Map();
    this.season = null; // latest season processed
    this.pre = new Map(); // gameId -> pre-game prediction (backtest)
    this.firstSeason = games.length ? games[0].season : null;

    for (const g of games) {
      if (!g.completed) continue;
      this._rollSeason(g.season);
      if (g.season !== this.firstSeason) {
        // Predict before the result is known so the backtest never leaks the outcome.
        this.pre.set(g.id, this.predict(g));
      }
      this._apply(g);
    }
  }

  _rollSeason(season) {
    if (this.season !== null && season > this.season) {
      for (const [id, r] of this.elo) this.elo.set(id, r + (START_ELO - r) * SEASON_REGRESSION);
    }
    if (this.season === null || season > this.season) this.season = season;
  }

  _apply(g) {
    const margin = g.homeScore - g.awayScore;
    const eh = this.elo.get(g.homeId);
    const ea = this.elo.get(g.awayId);
    const diff = eh + (g.neutral ? 0 : HOME_ELO) - ea;
    const expHome = 1 / (1 + 10 ** (-diff / 400));
    const actual = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    // Margin-of-victory multiplier damps blowouts by heavy favourites.
    const winnerDiff = margin >= 0 ? diff : -diff;
    const mov = Math.log(Math.abs(margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    const delta = K * mov * (actual - expHome);
    this.elo.set(g.homeId, eh + delta);
    this.elo.set(g.awayId, ea - delta);

    const hb = g.box?.[g.homeId] ?? null;
    const ab = g.box?.[g.awayId] ?? null;
    const both = hb && ab;
    // st = this team's own game stats, os = what its opponent did against it
    this.history.get(g.homeId)?.push({ date: g.date, season: g.season, opp: g.awayId, pf: g.homeScore, pa: g.awayScore, st: both ? hb : null, os: both ? ab : null });
    this.history.get(g.awayId)?.push({ date: g.date, season: g.season, opp: g.homeId, pf: g.awayScore, pa: g.homeScore, st: both ? ab : null, os: both ? hb : null });
    const key = pairKey(g.homeId, g.awayId);
    if (!this.h2h.has(key)) this.h2h.set(key, []);
    this.h2h.get(key).push(g);
  }

  _elo(id, season) {
    const r = this.elo.get(id) ?? START_ELO;
    // A game in a not-yet-started season: apply the offseason regression virtually.
    return this.season !== null && season > this.season ? r + (START_ELO - r) * SEASON_REGRESSION : r;
  }

  // Averages over a list of history entries that have box scores.
  _profile(entries) {
    const b = entries.filter((x) => x.st);
    const n = b.length;
    if (!n) return null;
    const a = (f) => avg(b.map(f));
    const thirdAtt = b.reduce((s, x) => s + x.st.thirdAtt, 0);
    return {
      n,
      yardsOff: a((x) => x.st.yards),
      yardsDef: a((x) => x.os.yards),
      yppOff: a((x) => x.st.ypp),
      yppDef: a((x) => x.os.ypp),
      possMin: a((x) => x.st.possSec) / 60,
      sacksDef: a((x) => x.os.sacksTaken), // sacks this defence recorded
      sacksAllowed: a((x) => x.st.sacksTaken),
      intsDef: a((x) => x.os.ints), // interceptions this defence recorded
      intsThrown: a((x) => x.st.ints),
      toMargin: a((x) => x.os.turnovers - x.st.turnovers),
      thirdPct: thirdAtt ? (b.reduce((s, x) => s + x.st.thirdConv, 0) / thirdAtt) * 100 : null,
      sacksDefTotal: b.reduce((s, x) => s + x.os.sacksTaken, 0),
      intsDefTotal: b.reduce((s, x) => s + x.os.ints, 0),
      takeaways: b.reduce((s, x) => s + x.os.turnovers, 0),
      giveaways: b.reduce((s, x) => s + x.st.turnovers, 0),
    };
  }

  teamStats(id, season) {
    const all = this.history.get(id) ?? [];
    const games = all.filter((x) => x.season === season);
    const n = games.length;
    const wins = games.filter((x) => x.pf > x.pa).length;
    const losses = games.filter((x) => x.pf < x.pa).length;
    const ties = n - wins - losses;
    const last = all.slice(-5);
    const p = this._profile(games); // season-to-date box-score stats
    const r1 = (v) => (v == null ? null : round1(v));
    const mmss = (min) => {
      const s = Math.round(min * 60);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    return {
      games: n,
      record: `${wins}-${losses}${ties ? `-${ties}` : ""}`,
      winPct: n ? round1(((wins + ties / 2) / n) * 100) : null,
      ppg: n ? round1(avg(games.map((x) => x.pf))) : null,
      papg: n ? round1(avg(games.map((x) => x.pa))) : null,
      margin: n ? round1(avg(games.map((x) => x.pf - x.pa))) : null,
      ypg: r1(p?.yardsOff),
      ypgAllowed: r1(p?.yardsDef),
      ypp: r1(p?.yppOff),
      yppAllowed: r1(p?.yppDef),
      possession: p ? mmss(p.possMin) : null,
      thirdDownPct: r1(p?.thirdPct),
      sacks: p ? p.sacksDefTotal : null, // total defensive sacks
      sacksAllowed: p ? Math.round(p.sacksAllowed * p.n) : null,
      interceptions: p ? p.intsDefTotal : null, // total defensive INTs
      takeaways: p ? p.takeaways : null,
      giveaways: p ? p.giveaways : null,
      turnoverDiff: p ? p.takeaways - p.giveaways : null, // total turnover differential
      last5: last.map((x) => (x.pf > x.pa ? "W" : x.pf < x.pa ? "L" : "T")),
      elo: Math.round(this._elo(id, season)),
    };
  }

  // League-average profile and per-team shrunk profile (rolling window across seasons).
  _shrunkProfiles() {
    const raw = new Map();
    for (const [tid, h] of this.history) raw.set(tid, this._profile(h.filter((x) => x.st).slice(-BOX_WINDOW)));
    const all = [...raw.values()].filter(Boolean);
    if (!all.length) return null;
    const keys = ["yardsOff", "yardsDef", "yppOff", "yppDef", "possMin", "sacksDef", "sacksAllowed", "intsDef", "intsThrown", "toMargin"];
    const lg = Object.fromEntries(keys.map((k) => [k, avg(all.map((p) => p[k]))]));
    lg.toMargin = 0;
    const shrunk = (tid) => {
      const p = raw.get(tid);
      const n = p?.n ?? 0;
      return Object.fromEntries(keys.map((k) => [k, ((p ? p[k] : 0) * n + lg[k] * BOX_PRIOR) / (n + BOX_PRIOR)]));
    };
    return { lg, get: shrunk, has: (tid) => (raw.get(tid)?.n ?? 0) >= 3 };
  }

  // Predict a game (a record with homeId, awayId, season, date, neutral) from current state.
  predict(g) {
    const { homeId, awayId, season, date } = g;
    const hAll = this.history.get(homeId) ?? [];
    const aAll = this.history.get(awayId) ?? [];
    const hSeason = hAll.filter((x) => x.season === season);
    const aSeason = aAll.filter((x) => x.season === season);

    const factors = [];
    const add = (key, label, points, detail) => factors.push({ key, label, points: round1(points), detail });

    // 1. Elo (long-run team strength incl. home field)
    const eloH = this._elo(homeId, season);
    const eloA = this._elo(awayId, season);
    const hfa = g.neutral ? 0 : HOME_ELO;
    add("elo", "Team strength (Elo)", (eloH - eloA) / ELO_PER_POINT, `${Math.round(eloH)} vs ${Math.round(eloA)}`);
    add("home", "Home field", hfa / ELO_PER_POINT, g.neutral ? "Neutral site" : "Home advantage");

    // 2. Current-season scoring margin (only once both teams have a few games)
    const mH = hSeason.length ? avg(hSeason.map((x) => x.pf - x.pa)) : 0;
    const mA = aSeason.length ? avg(aSeason.map((x) => x.pf - x.pa)) : 0;
    const trust = Math.min(hSeason.length, aSeason.length, 8) / 8;
    add(
      "season",
      "Season point differential",
      (mH - mA) * WEIGHTS.seasonMargin * trust,
      hSeason.length && aSeason.length ? `${signed(mH)} vs ${signed(mA)} per game` : "Not enough games yet"
    );

    // 3. Recent form (last 4 games, any season)
    const fH = hAll.slice(-4);
    const fA = aAll.slice(-4);
    const formH = avg(fH.map((x) => x.pf - x.pa));
    const formA = avg(fA.map((x) => x.pf - x.pa));
    add(
      "form",
      "Recent form (last 4)",
      fH.length && fA.length ? (formH - formA) * WEIGHTS.form : 0,
      fH.length && fA.length ? `${signed(formH)} vs ${signed(formA)} per game` : "No recent games"
    );

    // 4. Head-to-head (most recent 5 meetings before this game)
    const meetings = (this.h2h.get(pairKey(homeId, awayId)) ?? []).filter((m) => m.date < date).slice(-5);
    const h2hMargins = meetings.map((m) => (m.homeId === homeId ? m.homeScore - m.awayScore : m.awayScore - m.homeScore));
    const h2hPts = meetings.length
      ? clamp(avg(h2hMargins) * WEIGHTS.h2h * (Math.min(meetings.length, 4) / 4), -WEIGHTS.h2hCap, WEIGHTS.h2hCap)
      : 0;
    const h2hWinsHome = h2hMargins.filter((x) => x > 0).length;
    add(
      "h2h",
      "Head-to-head history",
      h2hPts,
      meetings.length ? `Home team won ${h2hWinsHome} of last ${meetings.length} meetings` : "No recent meetings"
    );

    // 5. Rest (days since each team's last game)
    const rest = (all) => {
      const prev = [...all].reverse().find((x) => x.date < date);
      return prev ? clamp((date - prev.date) / 86400000, 3, 14) : 7;
    };
    const restH = rest(hAll);
    const restA = rest(aAll);
    add(
      "rest",
      "Rest advantage",
      clamp((restH - restA) * WEIGHTS.rest, -WEIGHTS.restCap, WEIGHTS.restCap),
      `${Math.round(restH)} vs ${Math.round(restA)} days`
    );

    // 6. Box-score matchup factors: how each offence fares against the other's defence.
    const prof = BOX_SCALE ? this._shrunkProfiles() : null;
    if (prof && prof.has(homeId) && prof.has(awayId)) {
      const H = prof.get(homeId);
      const A = prof.get(awayId);
      const S = BOX_SCALE;
      const w = WEIGHTS;

      // Expected yards for each side = average of its offence and the opponent's defence.
      const yH = (H.yardsOff + A.yardsDef) / 2;
      const yA = (A.yardsOff + H.yardsDef) / 2;
      add("yards", "Yards per game matchup", (yH - yA) * w.yards * S, `${Math.round(yH)} vs ${Math.round(yA)} expected yds`);

      const netH = H.yppOff - H.yppDef;
      const netA = A.yppOff - A.yppDef;
      add("ypp", "Yards per play (net)", (netH - netA) * w.ypp * S, `${signed(netH)} vs ${signed(netA)} yds/play`);

      add(
        "possession",
        "Time of possession",
        clamp((H.possMin - A.possMin) * w.possession * S, -w.possessionCap, w.possessionCap),
        `${H.possMin.toFixed(1)} vs ${A.possMin.toFixed(1)} min/game`
      );

      const sH = (H.sacksDef + A.sacksAllowed) / 2; // sacks the home defence is expected to get
      const sA = (A.sacksDef + H.sacksAllowed) / 2;
      add(
        "sacks",
        "Sacks (pass rush vs. protection)",
        clamp((sH - sA) * w.sacks * S, -w.sacksCap, w.sacksCap),
        `${sH.toFixed(1)} vs ${sA.toFixed(1)} expected sacks`
      );

      const iH = (H.intsDef + A.intsThrown) / 2; // INTs the home defence is expected to get
      const iA = (A.intsDef + H.intsThrown) / 2;
      add(
        "ints",
        "Interceptions",
        clamp((iH - iA) * w.ints * S, -w.intsCap, w.intsCap),
        `${iH.toFixed(2)} vs ${iA.toFixed(2)} expected INTs`
      );

      add(
        "turnovers",
        "Turnover margin",
        clamp((H.toMargin - A.toMargin) * w.turnovers * S, -w.turnoversCap, w.turnoversCap),
        `${signed(H.toMargin)} vs ${signed(A.toMargin)} per game`
      );
    }

    // Calibration: pull the summed factors toward a pick'em so big spreads aren't overstated.
    const rawSum = factors.reduce((s, f) => s + f.points, 0);
    add("shrink", "Calibration (regression to the mean)", rawSum * (MODEL_SHRINK - 1), `Factors scaled to ${Math.round(MODEL_SHRINK * 100)}%`);

    // 7. Injuries to starters (upcoming games only; no historical injury reports exist to replay)
    if (g.injuries) {
      const delta = (g.injuries.awayHarm - g.injuries.homeHarm) * INJURY_SCALE;
      add("injuries", "Injuries to starters", delta, g.injuries.detail || "No key starters out");
    }

    const toProb = (sp) => 1 / (1 + 10 ** (-sp / (400 / ELO_PER_POINT)));
    const modelSpread = factors.reduce((s, f) => s + f.points, 0);
    const modelHome = toProb(modelSpread);

    // 8. Betting market: blend the closing/current line with the model's own spread.
    let spread = modelSpread;
    let market = null;
    if (g.odds && Number.isFinite(g.odds.spread)) {
      const mSpread = 0 - g.odds.spread; // ESPN gives the home line (negative = home favoured); "0 -" avoids -0
      spread = modelSpread * (1 - MARKET_WEIGHT) + mSpread * MARKET_WEIGHT;
      const homeAbbr = this.teams.get(homeId)?.abbr ?? "HOME";
      const awayAbbr = this.teams.get(awayId)?.abbr ?? "AWAY";
      const line = mSpread === 0 ? "Pick'em" : `${mSpread > 0 ? homeAbbr : awayAbbr} -${Math.abs(mSpread)}`;
      market = {
        provider: g.odds.provider,
        line,
        spread: mSpread, // home perspective, positive = home favoured
        total: g.odds.total,
        homeML: g.odds.homeML,
        awayML: g.odds.awayML,
        homeWinProb: marketHomeProb(g.odds, mSpread),
      };
      add("market", "Betting line", spread - modelSpread, `${line}, blended at ${Math.round(MARKET_WEIGHT * 100)}% weight`);
    }
    const pHome = toProb(spread);

    // Expected score: blend each side's offence with the opponent's defence, then
    // shift the total so the margin matches the predicted spread.
    const lg = LEAGUE_AVG_PPG;
    const shrink = (xs, f) => (avg(xs.map(f)) * xs.length + lg * 4) / (xs.length + 4);
    const offH = shrink(hSeason, (x) => x.pf);
    const defH = shrink(hSeason, (x) => x.pa);
    const offA = shrink(aSeason, (x) => x.pf);
    const defA = shrink(aSeason, (x) => x.pa);
    let total = clamp((offH + defA) / 2 + (offA + defH) / 2, 30, 62);
    if (g.odds?.total) total = (total + g.odds.total) / 2; // lean on the market's over/under too
    let homePts = Math.round((total + spread) / 2);
    let awayPts = Math.round((total - spread) / 2);
    if (homePts === awayPts) pHome >= 0.5 ? homePts++ : awayPts++;

    const winnerId = pHome >= 0.5 ? homeId : awayId;
    const pWin = Math.max(pHome, 1 - pHome);
    return {
      winnerId,
      homeWinProb: round1(pHome * 100),
      awayWinProb: round1((1 - pHome) * 100),
      confidence: pWin < 0.55 ? "Toss-up" : pWin < 0.65 ? "Lean" : pWin < 0.75 ? "Likely" : "Strong",
      spread: round1(spread), // positive = home favoured
      modelOnly: { winnerId: modelHome >= 0.5 ? homeId : awayId, homeWinProb: round1(modelHome * 100), spread: round1(modelSpread) },
      market,
      predictedScore: { home: homePts, away: awayPts },
      factors,
      headToHead: meetings
        .slice()
        .reverse()
        .map((m) => ({
          season: m.season,
          week: m.week,
          seasonType: m.seasonType,
          homeId: m.homeId,
          awayId: m.awayId,
          homeScore: m.homeScore,
          awayScore: m.awayScore,
        })),
    };
  }

  // Backtest summary over games predicted before kickoff, grouped by season. Also compares
  // the model alone, the market favourite and the blended pick on games that have a line.
  accuracy(games) {
    const bySeason = new Map();
    const cmp = { games: 0, model: 0, market: 0, blended: 0 };
    for (const g of games) {
      const p = this.pre.get(g.id);
      if (!p || g.homeScore === g.awayScore) continue;
      const actualWinner = g.homeScore > g.awayScore ? g.homeId : g.awayId;
      const s = bySeason.get(g.season) ?? { season: g.season, games: 0, correct: 0, homeWins: 0 };
      s.games++;
      if (p.winnerId === actualWinner) s.correct++;
      if (g.homeScore > g.awayScore) s.homeWins++;
      bySeason.set(g.season, s);
      if (p.market && p.market.spread !== 0) {
        cmp.games++;
        if (p.modelOnly.winnerId === actualWinner) cmp.model++;
        if ((p.market.spread > 0 ? g.homeId : g.awayId) === actualWinner) cmp.market++;
        if (p.winnerId === actualWinner) cmp.blended++;
      }
    }
    const seasons = [...bySeason.values()]
      .sort((a, b) => b.season - a.season)
      .map((s) => ({ ...s, accuracy: round1((s.correct / s.games) * 100), homeBaseline: round1((s.homeWins / s.games) * 100) }));
    const games_ = seasons.reduce((n, s) => n + s.games, 0);
    const correct = seasons.reduce((n, s) => n + s.correct, 0);
    const pct = (n) => (cmp.games ? round1((n / cmp.games) * 100) : null);
    return {
      games: games_,
      correct,
      accuracy: games_ ? round1((correct / games_) * 100) : null,
      compare: { games: cmp.games, model: pct(cmp.model), market: pct(cmp.market), blended: pct(cmp.blended) },
      seasons,
    };
  }
}

// Market win probability: de-vigged moneyline when both sides are posted, else from the spread.
function marketHomeProb(odds, mSpread) {
  const imp = (ml) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
  if (odds.homeML != null && odds.awayML != null) {
    const h = imp(odds.homeML);
    const a = imp(odds.awayML);
    return round1((h / (h + a)) * 100);
  }
  return round1((1 / (1 + 10 ** (-mSpread / (400 / ELO_PER_POINT)))) * 100);
}

function signed(x) {
  const v = round1(x);
  return v > 0 ? `+${v}` : `${v}`;
}

module.exports = { Model };
