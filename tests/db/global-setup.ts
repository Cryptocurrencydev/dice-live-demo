import pg from "pg";
import { DB_URL } from "./helpers";

// The live ticker (pg_cron, every 1s) would race the tests' manual clock control, so pause it
// for the run and restore it afterwards. Tests drive time by back-dating deadlines + calling tick.
export async function setup() {
  const c = new pg.Client(DB_URL);
  await c.connect();
  await c.query(`select cron.alter_job(jobid, active := false) from cron.job where jobname = 'snakeyes-tick'`);
  await c.end();
  return async () => {
    const d = new pg.Client(DB_URL);
    await d.connect();
    await d.query(`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'snakeyes-tick'`);
    await d.end();
  };
}
