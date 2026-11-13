const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTeamLineup, outProb } = require("../src/lineup");

const NOW = Date.UTC(2026, 10, 13);
const DAY = 86400000;
const slot = (s, ...names) => ({ slot: s, players: names.map((name, i) => ({ id: `${s}${i}`, name })) });
const inj = (name, status, over = {}) => ({ name, pos: "", status, detail: "", returnDate: null, comment: "", date: NOW - DAY, ...over });
const near = (actual, expected, tol = 0.11) => assert.ok(Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

test("outProb maps report designations to the chance a player misses the game", () => {
  assert.equal(outProb("Out"), 1);
  assert.equal(outProb("Injured Reserve"), 1);
  assert.equal(outProb("Suspension"), 1);
  assert.equal(outProb("Doubtful"), 0.85);
  assert.equal(outProb("Questionable"), 0.3);
  assert.equal(outProb("Day-To-Day"), 0.15);
  assert.equal(outProb("Active"), 0);
  assert.equal(outProb(null), 0);
  assert.equal(outProb(undefined), 0);
});

test("a healthy team has no injury cost", () => {
  const depth = { offense: [slot("qb", "Star QB", "Backup QB")], defense: [], special: [] };
  const l = buildTeamLineup(depth, [], NOW);
  assert.equal(l.impact.points, 0);
  assert.deepEqual(l.impact.items, []);
  assert.equal(l.offense[0].starter.name, "Star QB");
  assert.equal(l.offense[0].expected, null);
});

test("a starting QB who is out costs 4.5 points and the backup is the expected starter", () => {
  const depth = { offense: [slot("qb", "Star QB", "Backup QB")], defense: [], special: [] };
  const l = buildTeamLineup(depth, [inj("Star QB", "Out")], NOW);
  assert.equal(l.impact.points, 4.5);
  assert.equal(l.impact.items[0].slot, "QB");
  assert.equal(l.offense[0].starter.status, "Out");
  assert.equal(l.offense[0].expected.name, "Backup QB");
});

test("the expected replacement skips backups who are also out", () => {
  const depth = { offense: [slot("qb", "A", "B", "C")], defense: [], special: [] };
  const l = buildTeamLineup(depth, [inj("A", "Out"), inj("B", "Injured Reserve")], NOW);
  assert.equal(l.offense[0].expected.name, "C");
});

test("a questionable starter only costs part of his value", () => {
  const depth = { offense: [slot("wr1", "Receiver One")], defense: [], special: [] };
  const l = buildTeamLineup(depth, [inj("Receiver One", "Questionable")], NOW);
  near(l.impact.points, 0.9 * 0.3); // WR1 value 0.9 x 30% chance of missing
  assert.equal(l.offense[0].expected, null); // still expected to start
});

test("long-term absences are discounted because results already reflect them", () => {
  const depth = { offense: [slot("qb", "Star QB", "Backup QB")], defense: [], special: [] };
  const fresh = buildTeamLineup(depth, [inj("Star QB", "Injured Reserve", { date: NOW - 3 * DAY })], NOW);
  const stale = buildTeamLineup(depth, [inj("Star QB", "Injured Reserve", { date: NOW - 60 * DAY })], NOW);
  assert.equal(fresh.impact.points, 4.5);
  near(stale.impact.points, 4.5 * 0.25); // floor of 25%
});

test("total injury cost is capped at 10 points", () => {
  const depth = {
    offense: [slot("qb", "q1"), slot("wr1", "w1"), slot("wr2", "w2"), slot("lt", "t1"), slot("c", "c1")],
    defense: [slot("lde", "d1"), slot("rde", "d2"), slot("lcb", "b1"), slot("rcb", "b2"), slot("ldt", "n1"), slot("rdt", "n2"), slot("mlb", "m1")],
    special: [],
  };
  const everyone = ["q1", "w1", "w2", "t1", "c1", "d1", "d2", "b1", "b2", "n1", "n2", "m1"].map((n) => inj(n, "Out"));
  assert.equal(buildTeamLineup(depth, everyone, NOW).impact.points, 10);
});

test("players are matched across name suffixes and punctuation", () => {
  const depth = { offense: [slot("wr1", "Marvin Harrison Jr.")], defense: [], special: [] };
  const l = buildTeamLineup(depth, [inj("Marvin Harrison", "Out")], NOW);
  assert.equal(l.offense[0].starter.status, "Out");
  assert.ok(l.impact.points > 0);
});

test("only the kicker and punter count from special teams", () => {
  const depth = { offense: [], defense: [], special: [slot("pk", "Kicker"), slot("h", "Holder"), slot("ls", "Snapper")] };
  const l = buildTeamLineup(depth, [inj("Kicker", "Out"), inj("Holder", "Out"), inj("Snapper", "Out")], NOW);
  assert.equal(l.impact.points, 0.4);
  assert.deepEqual(l.special.map((s) => s.slot), ["pk"]);
});

test("3-4 front slot names and unknown slots are handled", () => {
  const depth = { offense: [], defense: [slot("lilb", "Backer"), slot("zz", "Mystery")], special: [] };
  const l = buildTeamLineup(depth, [inj("Backer", "Out"), inj("Mystery", "Out")], NOW);
  assert.equal(l.impact.points, 0.4); // lilb counts as a linebacker, the unknown slot is worth 0
});

test("the injury report lists lineup players first, then most severe", () => {
  const depth = { offense: [slot("rb", "Starter RB")], defense: [], special: [] };
  const report = [inj("Practice Squad Guy", "Out", { pos: "WR" }), inj("Starter RB", "Questionable", { pos: "RB" }), inj("Healthy", "Active")];
  const l = buildTeamLineup(depth, report, NOW);
  assert.deepEqual(l.injuries.map((i) => i.name), ["Starter RB", "Practice Squad Guy"]);
  assert.equal(l.injuries[0].inLineup, true);
  assert.equal(l.injuries[1].inLineup, false);
});

test("missing depth chart and missing injury report do not throw", () => {
  const l = buildTeamLineup(null, undefined, NOW);
  assert.equal(l.impact.points, 0);
  assert.deepEqual(l.offense, []);
});
