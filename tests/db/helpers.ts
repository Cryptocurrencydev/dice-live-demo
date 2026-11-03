import pg from "pg";
import { randomUUID } from "node:crypto";

export const DB_URL = process.env.TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

const clients: pg.Client[] = [];
export async function closeAll() {
  await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
}

/** Superuser connection: used ONLY to inspect state and move the clock, never to play. */
export async function admin() {
  const c = new pg.Client(DB_URL);
  await c.connect();
  clients.push(c);
  return {
    c,
    q: async <T = any>(sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as T[],
    one: async <T = any>(sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0] as T,
    room: async (id: string) => (await c.query(`select * from public.rooms where id = $1`, [id])).rows[0],
    /** pretend the current phase deadline has passed, then let the server resolve it */
    expire: async (id: string) => {
      await c.query(`update public.rooms set phase_deadline = now() - interval '1 ms',
                     phase_started_at = phase_started_at - interval '60 s' where id = $1`, [id]);
      await c.query(`select engine.tick_room($1)`, [id]);
    },
    age: async (id: string, secs: number) =>
      c.query(`update public.rooms set phase_started_at = now() - make_interval(secs => $2) where id = $1`, [id, secs]),
    tick: async (id: string) => c.query(`select engine.tick_room($1)`, [id]),
    balance: async (pid: string) => Number((await c.query(`select balance from public.players where id = $1`, [pid])).rows[0].balance),
    events: async (id: string) =>
      (await c.query(`select kind, actor_id, actor_name, data, created_at from public.events where room_id = $1 order by id`, [id])).rows,
  };
}

export type User = Awaited<ReturnType<typeof user>>;

/** A connection that behaves exactly like a signed-in browser client: role `authenticated`, auth.uid() set. */
export async function user(name?: string) {
  const id = randomUUID();
  const username = name ?? `p_${id.slice(0, 8)}`;
  const c = new pg.Client(DB_URL);
  await c.connect();
  clients.push(c);
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id, role: "authenticated" })]);
  await c.query(`set role authenticated`);
  await c.query(`select public.sign_in($1)`, [username]);
  const rpc = async <T = any>(fn: string, ...args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    const res = await c.query(`select public.${fn}(${ph}) as v`, args);
    return res.rows[0]?.v as T;
  };
  return { id, username, c, rpc };
}

/** Expect a call to fail with a given engine error code. */
export async function rejects(p: Promise<unknown>, code: string | RegExp) {
  try {
    await p;
  } catch (e) {
    const msg = (e as Error).message;
    if (typeof code === "string" ? msg === code : code.test(msg)) return;
    throw new Error(`expected ${code}, got: ${msg}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}
