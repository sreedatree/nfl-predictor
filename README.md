# NFL Game Predictor

A small web app that predicts the winner of every NFL game in a given week. It uses
team stats, head-to-head history, injuries to starters and the current betting line.
All data comes from ESPN's public endpoints, so no API key is needed.

## Run it

Requires Node.js 18 or newer.

```bash
cd nfl-predictor
npm install
npm start
```

Open http://localhost:3000. Use `PORT=3001 npm start` to pick another port.

The first start downloads about 420 box scores and betting lines, which takes a minute or
two. They are cached in `.cache/gamedata.json`, so later starts only fetch new games.
Use the week dropdown to move between regular season weeks and playoff rounds.

## What you see

For each game:

- A pick, win probability, confidence label and projected score.
- The betting line (spread, over/under, moneylines) next to the model's own pick. A gap of
  3 points or more is highlighted.
- Expected starting lineups with injury tags (OUT, IR, D for doubtful, Q for questionable)
  and the expected replacement when a starter is out.
- Season stats for both teams: points per game, yards per game, yards allowed, yards per
  play, time of possession, 3rd down %, total defensive sacks, total defensive
  interceptions and total turnover differential.
- A breakdown of every factor behind the pick, in points of spread.
- The last five head-to-head meetings.

Finished games show the pick that was made before kickoff, marked correct or missed.

## How the prediction works

Everything is expressed as a point spread from the home team's view, then converted to a
win probability.

1. **Elo rating** built from three seasons of results, with a margin-of-victory
   multiplier and regression to the mean each new season. Home field is worth about 2 points.
2. **Season point differential**, **recent form** (last 4 games), **head-to-head**
   (last 5 meetings) and **rest days**.
3. **Box-score matchups** over each team's last 10 games: yards per game, yards per play,
   time of possession, sacks (pass rush vs. protection), interceptions and turnover margin.
   Each offence is compared with the opposing defence. These weights are small on purpose,
   because they overlap with Elo and point differential.
4. **Calibration**: the summed factors are scaled to 70%, because the raw sum was
   overconfident in the backtest.
5. **Injuries to starters** (upcoming games only): each starter who is out, doubtful or
   questionable costs his team a position-based number of points, for example 4.5 for a
   quarterback and 0.3 to 0.9 for most other starters. Absences older than two weeks count
   less, because the team's results already reflect them.
6. **Betting line**: when a line is posted, the final spread is 70% line and 30% model.

All weights live at the top of `src/model.js` and `src/lineup.js`.

## Accuracy

Backtest over 420 games from 2025 and 2026, where every pick uses only information from
before kickoff:

| Picks | Correct |
| --- | --- |
| Overall (blended where a line exists) | 66.0% |
| Home team every time (baseline) | about 52% |
| On the 241 games with lines: model alone | 64.3% |
| On the 241 games with lines: betting line alone | 65.6% |
| On the 241 games with lines: blended | 66.0% |

The line is a stronger predictor than the model alone, and the blend is statistically tied
with it on this sample. The page header shows these numbers live.

Known limits:

- **Injury values are estimates.** ESPN has no historical injury reports, so they could not
  be backtested. They follow commonly cited ranges for what players are worth on the spread.
- **Only about 57% of backtest games have a stored line.** The rest use the model alone.
- **No quarterback quality, weather or travel.** A quarterback who is out is counted,
  but the size of the drop-off to his backup is a flat estimate.
- Small samples are noisy. One week's record says little.

This is for entertainment, not betting advice.

## Project layout

```
server.js         Express server and the /api/predictions endpoint
src/espn.js       ESPN client: schedules, box scores, lines, injuries, depth charts
src/model.js      Elo, factors, market blend and backtest
src/lineup.js     Depth chart + injury report -> lineup and injury cost
public/           Static front end (index.html, app.js, style.css)
.cache/           Box scores and lines for finished games (gitignored)
```

## API

`GET /api/predictions?seasonType=2&week=10`

- `seasonType`: `2` regular season, `3` playoffs. Defaults to the current week.
- `week`: week number. In the playoffs, ESPN numbers the rounds 1, 2, 3 and 5 (Super Bowl).
- `season`: optional, defaults to the current season.

The response has the games with predictions, lineups, the model's accuracy summary and
the week's record.

## Data refresh

Schedules, the injury report and depth charts are cached in memory for 10 to 30 minutes.
Betting lines for upcoming games are cached for 5 minutes. Restart the server to clear
all caches.
