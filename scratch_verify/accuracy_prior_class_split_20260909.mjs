// 2026-09-09 signal-accuracy audit: prior-classification split for today's flyers/divers,
// proving whether the "made high despite Buy" AND "made high as recommended (Buy)" sides
// are both populated, or whether direction is inverted somewhere in the pipeline.
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await c.connect();
async function q(label, sql) {
  try {
    const r = await c.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) { console.log(`\n=== ${label} === ERROR: ${e.message}`); }
}

// 1) what the retrospective recorded for the latest date: direction x prior_classification x wrong_call
await q('high_flyer_retrospective latest date: direction x prior class x wrong_call', `
  SELECT date, direction, prior_classification, wrong_call, COUNT(*) AS n
    FROM high_flyer_retrospective
   WHERE date = (SELECT MAX(date) FROM high_flyer_retrospective)
   GROUP BY 1,2,3,4 ORDER BY direction, prior_classification, wrong_call`);

// 2) distribution of ALL classifications in the latest unified_recommendations run (sanely directional?)
await q('unified_recommendations classification distribution (latest computed_at)', `
  SELECT classification, COUNT(*) AS n FROM unified_recommendations
   WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
   GROUP BY 1 ORDER BY n DESC LIMIT 12`);

// 3) ranker semantic check: unified_score mean by classification (higher = Buy expected)
await q('unified_score range by classification (is Buy scored above Sell?)', `
  SELECT classification, COUNT(*) AS n,
         round(AVG(unified_score)::numeric, 2) AS avg_score,
         round(MIN(unified_score)::numeric, 2) AS min_score,
         round(MAX(unified_score)::numeric, 2) AS max_score
    FROM unified_recommendations
   WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
   GROUP BY 1 ORDER BY avg_score DESC LIMIT 12`);

// 4) today's flyers with prior classifications: how many Buy-correct vs Sell-wrong vs unrated
await q('today flyers: prior-class bucket splits', `
  SELECT prior_classification,
         CASE WHEN prior_classification IN ('Buy','Strong Buy') THEN 'BUY'
              WHEN prior_classification IN ('Sell','Strong Sell') THEN 'SELL'
              WHEN prior_classification IS NULL THEN 'NULL'
              ELSE 'OTHER' END AS bucket,
         COUNT(*) AS n, round(AVG(return_pct)::numeric,1) AS avg_ret
    FROM high_flyer_retrospective
   WHERE date = (SELECT MAX(date) FROM high_flyer_retrospective) AND direction = 'up'
   GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`);

await q('today divers: prior-class bucket splits', `
  SELECT prior_classification,
         CASE WHEN prior_classification IN ('Sell','Strong Sell') THEN 'SELL'
              WHEN prior_classification IN ('Buy','Strong Buy') THEN 'BUY'
              WHEN prior_classification IS NULL THEN 'NULL'
              ELSE 'OTHER' END AS bucket,
         COUNT(*) AS n, round(AVG(return_pct)::numeric,1) AS avg_ret
    FROM high_flyer_retrospective
   WHERE date = (SELECT MAX(date) FROM high_flyer_retrospective) AND direction = 'down'
   GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`);

await c.end();