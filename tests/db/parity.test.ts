import { afterAll, describe, expect, it } from "vitest";
import { admin, closeAll } from "./helpers";
import { catchVerdict, resolveRoll, RULES, settleBet, type Side } from "@/lib/rules";

// The UI explains outcomes with src/lib/rules.ts; the server settles with the SQL rules.
// These must never disagree, so every input is checked against both.
afterAll(closeAll);

describe("rules parity: TypeScript module vs Postgres", () => {
  it("rules_config matches RULES", async () => {
    const a = await admin();
    const { v } = await a.one(`select public.rules_config() as v`);
    expect(v).toEqual({ ...RULES });
  });

  it("resolve_roll agrees for every point × total", async () => {
    const a = await admin();
    for (const point of [null, 4, 5, 6, 8, 9, 10]) {
      for (let total = 2; total <= 12; total++) {
        const { v } = await a.one(`select public.rules_resolve_roll($1, $2) as v`, [point, total]);
        expect(v, `point=${point} total=${total}`).toEqual(resolveRoll(point, total));
      }
    }
  });

  it("settle_bet agrees", async () => {
    const a = await admin();
    for (const side of ["with", "against"] as Side[])
      for (const result of ["win", "lose"] as const)
        for (const amount of [10, 125, 1000]) {
          const { v } = await a.one(`select public.rules_settle_bet($1, $2, $3) as v`, [side, amount, result]);
          expect(Number(v)).toBe(settleBet(side, amount, result));
        }
  });

  it("catch_verdict agrees for every vote count up to 8 seats", async () => {
    const a = await admin();
    const rows = await a.q(`
      select e, y, n, closed, public.rules_catch_verdict(e, y, n, closed) as v
      from generate_series(0, 7) e, generate_series(0, 7) y, generate_series(0, 7) n, (values (true), (false)) c(closed)
      where y + n <= e`);
    expect(rows.length).toBeGreaterThan(200);
    for (const r of rows) expect(r.v).toBe(catchVerdict(r.e, r.y, r.n, r.closed));
  });
});
