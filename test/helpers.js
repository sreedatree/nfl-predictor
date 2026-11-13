// Shared fixtures for the tests. Everything here is synthetic: no network access.

const teams = ["1", "2", "3", "4"].map((id) => ({
  id,
  abbr: `T${id}`,
  name: `Team ${id}`,
  short: `T${id}`,
  color: "#000000",
  logo: null,
}));

let nextId = 0;
const DAY = 86400000;

// A completed (or scheduled) game. `day` is the number of days after Sept 1 of `season`.
function game({ season = 2025, day = 0, home, away, hs = 20, as = 17, box = null, odds = null, neutral = false, completed = true }) {
  return {
    id: `g${++nextId}`,
    date: Date.UTC(season, 8, 1) + day * DAY,
    season,
    seasonType: 2,
    week: Math.floor(day / 7) + 1,
    neutral,
    completed,
    homeId: home,
    awayId: away,
    homeScore: completed ? hs : null,
    awayScore: completed ? as : null,
    box,
    odds,
  };
}

// Box score stats for one team in one game, with overrides.
function stats(over = {}) {
  return {
    yards: 350,
    passYards: 230,
    rushYards: 120,
    plays: 62,
    ypp: 5.6,
    possSec: 1800,
    turnovers: 1,
    ints: 1,
    sacksTaken: 2,
    thirdConv: 5,
    thirdAtt: 12,
    firstDowns: 20,
    ...over,
  };
}

module.exports = { teams, game, stats, DAY };
