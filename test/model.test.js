const test = require("node:test");
const assert = require("node:assert/strict");
const { Model } = require("../src/model");
const { teams, game, stats } = require("./helpers");

const near = (actual, expected, tol = 0.11) => assert.ok(Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);
const factor = (p, key) => p.factors.find((f) => f.key === key);
const fixture = (over = {}) => ({ homeId: "1", awayId: "2", season: 2025, date: Date.UTC(2025, 8, 20), neutral: true, ...over });

// ---- Elo ---------------------------------------------------------------------

test("Elo rewards the winner and is zero-sum", () => {
  const m = new Model([game({ home: "1", away: "2", hs: 27, as: 10 })], teams);
  assert.ok(m.elo.get("1") > 1500);
  assert.ok(m.elo.get("2") < 1500);
  near([...m.elo.values()].reduce((a, b) => a + b, 0), 6000, 0.001);
});

test("scheduled (unplayed) games do not change ratings", () => {
  const m = new Model([game({ home: "1", away: "2", completed: false })], teams);
  assert.equal(m.elo.get("1"), 1500);
  assert.equal(m.elo.get("2"), 1500);
});

test("ratings regress a third of the way to the mean in a new season", () => {
  const g24 = game({ season: 2024, home: "1", away: "2", hs: 35, as: 7 });
  const before = new Model([g24], teams).elo.get("1");
  const after = new Model([g24, game({ season: 2025, home: "3", away: "4" })], teams).elo.get("1");
  assert.ok(before > 1500);
  near(after, 1500 + (before - 1500) * (2 / 3), 1);
});

// ---- Basic predictions --------------------------------------------------------

test("equal teams on a neutral field are a coin flip", () => {
  const p = new Model([], teams).predict(fixture());
  assert.equal(p.homeWinProb, 50);
  assert.equal(p.awayWinProb, 50);
  assert.ok(Math.abs(p.spread) < 0.05);
  assert.equal(p.market, null);
});

test("home field favours the home team, and not at a neutral site", () => {
  const m = new Model([], teams);
  const home = m.predict(fixture({ neutral: false }));
  const neutral = m.predict(fixture({ neutral: true }));
  assert.ok(home.homeWinProb > 50);
  assert.equal(home.winnerId, "1");
  assert.equal(factor(home, "home").points, 2);
  assert.equal(factor(neutral, "home").points, 0);
});

test("a stronger team is favoured whether it is home or away", () => {
  const wins = [0, 7, 14, 21].map((day, i) => game({ day, home: i % 2 ? "2" : "1", away: i % 2 ? "1" : "2", hs: i % 2 ? 10 : 31, as: i % 2 ? 31 : 10 }));
  const m = new Model(wins, teams); // team 1 won all four
  const asHome = m.predict(fixture({ homeId: "1", awayId: "2", date: Date.UTC(2025, 9, 1) }));
  const asAway = m.predict(fixture({ homeId: "2", awayId: "1", date: Date.UTC(2025, 9, 1) }));
  assert.equal(asHome.winnerId, "1");
  assert.equal(asAway.winnerId, "1");
  assert.ok(asHome.homeWinProb > asAway.homeWinProb);
});

test("win probabilities add to 100 and the projected score picks the same winner", () => {
  const m = new Model([game({ home: "1", away: "2", hs: 31, as: 10 })], teams);
  for (const f of [fixture(), fixture({ neutral: false }), fixture({ homeId: "3", awayId: "4" })]) {
    const p = m.predict(f);
    near(p.homeWinProb + p.awayWinProb, 100, 0.11);
    const homeAhead = p.predictedScore.home > p.predictedScore.away;
    assert.equal(p.winnerId, homeAhead ? f.homeId : f.awayId);
    assert.notEqual(p.predictedScore.home, p.predictedScore.away); // no tied projections
  }
});

test("the displayed factors add up to the final spread", () => {
  const m = new Model([game({ home: "1", away: "2", hs: 24, as: 20 })], teams);
  const p = m.predict(fixture({ neutral: false, odds: { provider: "Book", spread: -3, total: 44, homeML: -150, awayML: 130 }, injuries: { homeHarm: 1, awayHarm: 2.5, detail: "x" } }));
  const sum = p.factors.reduce((s, f) => s + f.points, 0);
  near(sum, p.spread, 0.2); // each factor is rounded to 0.1
  assert.ok(factor(p, "shrink"));
});

// ---- Betting line ---------------------------------------------------------------

const LINE = { provider: "Book", spread: -3, total: 44, homeML: -150, awayML: 130 };

test("a home-favourite line pulls the pick toward the home team (70% market weight)", () => {
  const p = new Model([], teams).predict(fixture({ odds: LINE }));
  assert.equal(p.market.spread, 3); // ESPN's -3 home line means home favoured by 3
  assert.equal(p.market.line, "T1 -3");
  near(p.spread, 2.1); // 0.3 x model (0) + 0.7 x market (3)
  assert.equal(p.winnerId, "1");
  near(p.modelOnly.spread, 0);
  near(factor(p, "market").points, 2.1);
});

test("an away-favourite line flips the pick", () => {
  const p = new Model([], teams).predict(fixture({ odds: { ...LINE, spread: 3, homeML: 130, awayML: -150 } }));
  assert.equal(p.market.spread, -3);
  assert.equal(p.market.line, "T2 -3");
  near(p.spread, -2.1);
  assert.equal(p.winnerId, "2");
});

test("market win probability removes the bookmaker's margin", () => {
  const p = new Model([], teams).predict(fixture({ odds: LINE }));
  // -150 => 60.0% implied, +130 => 43.5% implied; normalised to 100% => ~58.0%
  near(p.market.homeWinProb, 58, 0.2);
});

test("market probability falls back to the spread when moneylines are missing", () => {
  const p = new Model([], teams).predict(fixture({ odds: { provider: "Book", spread: -3, total: null, homeML: null, awayML: null } }));
  assert.ok(p.market.homeWinProb > 50);
});

test("a pick'em line is labelled and does not move the model", () => {
  const p = new Model([], teams).predict(fixture({ neutral: false, odds: { provider: "Book", spread: 0, total: 40, homeML: -110, awayML: -110 } }));
  assert.equal(p.market.line, "Pick'em");
  assert.equal(p.market.spread, 0);
});

test("the over/under pulls the projected total toward the market", () => {
  const low = new Model([], teams).predict(fixture({ odds: { ...LINE, total: 34 } }));
  const high = new Model([], teams).predict(fixture({ odds: { ...LINE, total: 60 } }));
  const sum = (p) => p.predictedScore.home + p.predictedScore.away;
  assert.ok(sum(high) > sum(low) + 10);
});

// ---- Injuries --------------------------------------------------------------------

test("injuries to the away team favour the home team, and vice versa", () => {
  const m = new Model([], teams);
  const awayHurt = m.predict(fixture({ injuries: { homeHarm: 0, awayHarm: 3, detail: "QB out" } }));
  const homeHurt = m.predict(fixture({ injuries: { homeHarm: 3, awayHarm: 0, detail: "QB out" } }));
  assert.equal(factor(awayHurt, "injuries").points, 3);
  assert.equal(factor(homeHurt, "injuries").points, -3);
  assert.equal(awayHurt.winnerId, "1");
  assert.equal(homeHurt.winnerId, "2");
});

test("no injury factor is added when no injury data is supplied", () => {
  assert.equal(factor(new Model([], teams).predict(fixture()), "injuries"), undefined);
});

// ---- Head-to-head -------------------------------------------------------------------

const meetings = () => [
  game({ day: 0, home: "1", away: "2", hs: 24, as: 17 }),
  game({ day: 7, home: "2", away: "1", hs: 14, as: 20 }),
  game({ day: 14, home: "1", away: "2", hs: 27, as: 10 }),
];

test("head-to-head lists earlier meetings, newest first, and ignores later games", () => {
  const m = new Model(meetings(), teams);
  const all = m.predict(fixture({ date: Date.UTC(2025, 9, 1) }));
  assert.equal(all.headToHead.length, 3);
  assert.deepEqual(all.headToHead.map((h) => h.week), [3, 2, 1]);
  const early = m.predict(fixture({ date: Date.UTC(2025, 8, 1) + 10 * 86400000 })); // after game 2 only
  assert.equal(early.headToHead.length, 2);
});

test("a team that keeps beating an opponent gets a head-to-head edge", () => {
  const m = new Model(meetings(), teams);
  const p = m.predict(fixture({ date: Date.UTC(2025, 9, 1) }));
  assert.ok(factor(p, "h2h").points > 0); // team 1 won all three, by 7, 6 and 17
  const flipped = m.predict(fixture({ homeId: "2", awayId: "1", date: Date.UTC(2025, 9, 1) }));
  assert.ok(factor(flipped, "h2h").points < 0);
});

// ---- Box-score stats ----------------------------------------------------------------

// Team 1 is the better side in all three games: more yards, more sacks, takeaways.
const boxGames = (withBox = true) => [
  game({ day: 0, home: "1", away: "2", hs: 24, as: 17, box: withBox ? { 1: stats({ sacksTaken: 1, ints: 1, turnovers: 1, yards: 400 }), 2: stats({ sacksTaken: 4, ints: 1, turnovers: 2, yards: 300 }) } : null }),
  game({ day: 7, home: "2", away: "1", hs: 14, as: 20, box: withBox ? { 2: stats({ sacksTaken: 5, ints: 0, turnovers: 2, yards: 320 }), 1: stats({ sacksTaken: 2, ints: 2, turnovers: 2, yards: 380 }) } : null }),
  game({ day: 14, home: "1", away: "2", hs: 27, as: 10, box: withBox ? { 1: stats({ sacksTaken: 3, ints: 0, turnovers: 0, yards: 420 }), 2: stats({ sacksTaken: 6, ints: 2, turnovers: 3, yards: 280 }) } : null }),
];

test("season stats include the totals: defensive sacks, defensive INTs and turnover differential", () => {
  const m = new Model(boxGames(), teams);
  const one = m.teamStats("1", 2025);
  const two = m.teamStats("2", 2025);
  assert.equal(one.record, "3-0");
  assert.equal(one.sacks, 15); // opponent was sacked 4 + 5 + 6 times
  assert.equal(two.sacks, 6); // 1 + 2 + 3
  assert.equal(one.interceptions, 3); // opponent threw 1 + 0 + 2
  assert.equal(two.interceptions, 3); // 1 + 2 + 0
  assert.equal(one.takeaways, 7);
  assert.equal(one.giveaways, 3);
  assert.equal(one.turnoverDiff, 4);
  assert.equal(two.turnoverDiff, -4);
  assert.equal(one.sacksAllowed, 6);
});

test("season stats include yards, possession and third-down rate", () => {
  const one = new Model(boxGames(), teams).teamStats("1", 2025);
  assert.equal(one.ypg, 400); // (400 + 380 + 420) / 3
  assert.equal(one.ypgAllowed, 300); // (300 + 320 + 280) / 3
  assert.equal(one.possession, "30:00");
  assert.equal(one.thirdDownPct, 41.7); // 5 of 12 every game
  assert.equal(one.ppg, 23.7); // (24 + 20 + 27) / 3
});

test("box-score matchup factors appear when both teams have enough box scores", () => {
  const p = new Model(boxGames(), teams).predict(fixture({ date: Date.UTC(2025, 9, 1) }));
  for (const key of ["yards", "ypp", "possession", "sacks", "ints", "turnovers"]) assert.ok(factor(p, key), `missing ${key}`);
  assert.ok(factor(p, "yards").points > 0);
  assert.ok(factor(p, "turnovers").points > 0);
  assert.ok(factor(p, "sacks").points > 0);
  const flipped = new Model(boxGames(), teams).predict(fixture({ homeId: "2", awayId: "1", date: Date.UTC(2025, 9, 1) }));
  assert.ok(factor(flipped, "yards").points < 0);
});

test("box-score factors are skipped when box scores are missing", () => {
  const p = new Model(boxGames(false), teams).predict(fixture({ date: Date.UTC(2025, 9, 1) }));
  for (const key of ["yards", "ypp", "possession", "sacks", "ints", "turnovers"]) assert.equal(factor(p, key), undefined);
  assert.equal(new Model(boxGames(false), teams).teamStats("1", 2025).ypg, null);
});

// ---- Backtest integrity ---------------------------------------------------------------

const season = () => [
  game({ season: 2024, day: 0, home: "1", away: "2", hs: 20, as: 13 }), // burn-in season, never predicted
  game({ day: 0, home: "1", away: "2", hs: 24, as: 17, odds: { provider: "B", spread: -3, total: 44, homeML: -150, awayML: 130 } }),
  game({ day: 7, home: "3", away: "4", hs: 10, as: 20, odds: { provider: "B", spread: -4, total: 41, homeML: -180, awayML: 150 } }),
  game({ day: 14, home: "1", away: "3", hs: 17, as: 17, odds: { provider: "B", spread: -2, total: 40, homeML: -130, awayML: 110 } }),
  game({ day: 21, home: "2", away: "3", hs: 21, as: 14 }),
  game({ day: 28, home: "4", away: "1", hs: 13, as: 30, odds: { provider: "B", spread: 6, total: 45, homeML: 200, awayML: -250 } }),
];

test("picks are made without knowing the result of the game itself", () => {
  const games = season();
  const k = 4; // the 2025 game on day 21
  const base = new Model(games, teams).pre.get(games[k].id);
  const rewritten = games.map((g, i) => (i === k ? { ...g, homeScore: 0, awayScore: 45 } : g));
  assert.deepEqual(new Model(rewritten, teams).pre.get(games[k].id), base);
});

test("picks are made without knowing any later games", () => {
  const games = season();
  const k = 3;
  const full = new Model(games, teams).pre.get(games[k].id);
  const upToThen = new Model(games.slice(0, k), teams).predict(games[k]);
  assert.deepEqual(upToThen, full);
});

test("the first season is only used to build ratings, never graded", () => {
  const games = season();
  const m = new Model(games, teams);
  assert.equal(m.pre.has(games[0].id), false);
  assert.equal(m.pre.has(games[1].id), true);
});

test("accuracy compares the model, the line and the blend, and skips ties and the first season", () => {
  const games = season();
  const a = new Model(games, teams).accuracy(games);
  assert.equal(a.games, 4); // 5 games in 2025, minus the tie
  assert.ok(a.correct >= 0 && a.correct <= a.games);
  assert.equal(a.seasons.length, 1);
  assert.equal(a.seasons[0].season, 2025);
  assert.equal(a.seasons[0].homeBaseline, 50); // home won 2 of the 4 decided games
  // lines exist for 3 decided games (the tie is excluded); the favourite won twice and lost once
  assert.equal(a.compare.games, 3);
  near(a.compare.market, 66.7, 0.1);
  for (const v of [a.compare.model, a.compare.market, a.compare.blended, a.accuracy]) assert.ok(v >= 0 && v <= 100);
});
