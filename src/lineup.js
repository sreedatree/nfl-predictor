// Turns an ESPN depth chart + the league injury report into a starting lineup with
// injury flags, plus an estimate of how many points of spread the absences cost.
//
// The point values are heuristics, not fitted: ESPN has no historical injury reports,
// so they can't be backtested. They follow the commonly cited market ranges (a starting
// QB is worth roughly 4-7 points, most other starters well under 1-2 points).

const VALUES = {
  // offense
  qb: 4.5, rb: 0.5, fb: 0.1, wr1: 0.9, wr2: 0.6, wr3: 0.35, te: 0.5,
  lt: 0.7, lg: 0.4, c: 0.5, rg: 0.4, rt: 0.5,
  // defense
  lde: 0.7, rde: 0.7, ldt: 0.5, rdt: 0.5, nt: 0.5, wlb: 0.4, mlb: 0.5, slb: 0.4,
  lcb: 0.7, rcb: 0.7, nb: 0.35, ss: 0.4, fs: 0.4,
  // special teams (only kicker and punter matter)
  pk: 0.4, p: 0.1,
};
const MAX_TEAM_HARM = 10;

// Fallbacks for slot names that differ by scheme (e.g. 3-4 fronts: lolb, rilb, ...).
function slotValue(slot) {
  if (slot in VALUES) return VALUES[slot];
  if (/^(l|r)?(o|i)?lb$/.test(slot)) return 0.4;
  if (/de$|^(l|r)?olb$/.test(slot)) return 0.6;
  if (/dt$|nt$/.test(slot)) return 0.5;
  if (/cb$/.test(slot)) return 0.6;
  if (/s$/.test(slot)) return 0.4;
  return 0;
}

const LABELS = { nb: "NB", pk: "K", p: "P" };
const label = (slot) => LABELS[slot] ?? slot.toUpperCase();

const norm = (n) =>
  String(n)
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");

// Probability the player misses the game, from his report designation.
function outProb(status) {
  const s = String(status ?? "").toLowerCase();
  if (/\bout\b|injured reserve|\bir\b|pup|suspen|non-football/.test(s)) return 1;
  if (s.includes("doubtful")) return 0.85;
  if (s.includes("questionable")) return 0.3;
  if (s.includes("day")) return 0.15;
  return 0;
}

// A player who has been out for weeks is already reflected in the team's recent results
// and Elo, so only count recent absences at full weight.
function recency(inj, now) {
  if (outProb(inj.status) < 1 || !inj.date) return 1;
  const ageDays = (now - inj.date) / 86400000;
  if (ageDays <= 14) return 1;
  return Math.max(0.25, 1 - ((ageDays - 14) / 28) * 0.75);
}

const severity = (status) => outProb(status);

function buildTeamLineup(depth, injuries, now = Date.now()) {
  const injByName = new Map((injuries ?? []).map((i) => [norm(i.name), i]));
  const items = [];
  let total = 0;

  const group = (slots, keep) =>
    (slots ?? [])
      .filter((s) => keep(s.slot) && s.players.length)
      .map((s) => {
        const players = s.players.map((p) => {
          const inj = injByName.get(norm(p.name));
          return { name: p.name, status: inj?.status ?? null, detail: inj?.detail ?? null, _inj: inj };
        });
        const starter = players[0];
        const out = starter._inj ? outProb(starter._inj.status) : 0;
        // Expected starter: the first player who is not (almost) certainly out.
        const expected = out >= 0.85 ? players.slice(1).find((p) => !p._inj || outProb(p._inj.status) < 0.85) ?? null : null;
        const harm = slotValue(s.slot) * out * (starter._inj ? recency(starter._inj, now) : 1);
        if (harm > 0.05) {
          total += harm;
          items.push({ name: starter.name, slot: label(s.slot), status: starter.status, harm: Math.round(harm * 10) / 10 });
        }
        const strip = ({ name, status, detail }) => ({ name, status, detail });
        return {
          slot: s.slot,
          label: label(s.slot),
          starter: strip(starter),
          expected: expected ? strip(expected) : null,
          backups: players.slice(1, 3).map(strip),
        };
      });

  const lineup = {
    offense: group(depth?.offense, () => true),
    defense: group(depth?.defense, () => true),
    special: group(depth?.special, (s) => s === "pk" || s === "p"),
  };

  const starters = new Set(
    [...lineup.offense, ...lineup.defense, ...lineup.special].flatMap((s) => [s.starter.name, ...s.backups.map((b) => b.name)]).map(norm)
  );
  const report = (injuries ?? [])
    .filter((i) => severity(i.status) > 0)
    .map((i) => ({
      name: i.name,
      pos: i.pos,
      status: i.status,
      detail: i.detail,
      returnDate: i.returnDate,
      comment: i.comment,
      inLineup: starters.has(norm(i.name)),
    }))
    .sort((a, b) => Number(b.inLineup) - Number(a.inLineup) || severity(b.status) - severity(a.status));

  items.sort((a, b) => b.harm - a.harm);
  return {
    ...lineup,
    injuries: report.slice(0, 20),
    impact: { points: Math.round(Math.min(total, MAX_TEAM_HARM) * 10) / 10, items: items.slice(0, 5) },
  };
}

module.exports = { buildTeamLineup, outProb };
