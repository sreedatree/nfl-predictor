const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOdds, parseTeamBox } = require("../src/espn");

test("parseOdds reads ESPN's home line, total and moneylines", () => {
  const o = parseOdds({
    provider: { name: "DraftKings" },
    details: "KC -2.5",
    spread: -2.5,
    overUnder: 42.5,
    homeTeamOdds: { moneyLine: -130 },
    awayTeamOdds: { moneyLine: 110 },
  });
  assert.deepEqual(o, { provider: "DraftKings", spread: -2.5, total: 42.5, homeML: -130, awayML: 110, details: "KC -2.5" });
});

test("parseOdds tolerates missing pieces", () => {
  const o = parseOdds({ spread: "3", overUnder: "", homeTeamOdds: {}, awayTeamOdds: {} });
  assert.equal(o.spread, 3);
  assert.equal(o.total, null);
  assert.equal(o.homeML, null);
  assert.equal(o.awayML, null);
  assert.equal(o.provider, null);
});

test("parseOdds returns null when there is no usable line", () => {
  assert.equal(parseOdds(null), null);
  assert.equal(parseOdds(undefined), null);
  assert.equal(parseOdds({}), null);
  assert.equal(parseOdds({ spread: "n/a" }), null);
});

const stat = (name, displayValue) => ({ name, displayValue });

test("parseTeamBox turns a box score into per-game team stats", () => {
  const b = parseTeamBox({
    statistics: [
      stat("firstDowns", "21"),
      stat("thirdDownEff", "5-12"),
      stat("totalOffensivePlays", "62"),
      stat("totalYards", "345"),
      stat("yardsPerPlay", "5.6"),
      stat("netPassingYards", "230"),
      stat("rushingYards", "115"),
      stat("sacksYardsLost", "4-16"),
      stat("turnovers", "2"),
      stat("possessionTime", "26:18"),
      stat("interceptions", "1"),
    ],
  });
  assert.deepEqual(b, {
    yards: 345,
    passYards: 230,
    rushYards: 115,
    plays: 62,
    ypp: 5.6,
    possSec: 26 * 60 + 18,
    turnovers: 2,
    ints: 1,
    sacksTaken: 4,
    thirdConv: 5,
    thirdAtt: 12,
    firstDowns: 21,
  });
});

test("parseTeamBox handles thousands separators and missing stats", () => {
  const b = parseTeamBox({ statistics: [stat("totalYards", "1,012")] });
  assert.equal(b.yards, 1012);
  assert.equal(b.possSec, 0);
  assert.equal(b.sacksTaken, 0);
  assert.equal(b.thirdAtt, 0);
  assert.equal(parseTeamBox({}).yards, 0);
});

test("when ESPN repeats a stat name, the first value wins", () => {
  const b = parseTeamBox({ statistics: [stat("interceptions", "1"), stat("interceptions", "9")] });
  assert.equal(b.ints, 1);
});
