import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, closeAll, rejects, user, type User } from "./helpers";

// These tests talk to the real Postgres functions exactly as a browser would
// (role `authenticated`, auth.uid() from the JWT claims). The superuser `admin`
// connection is only used to read state and to move the clock forward.

let A: Awaited<ReturnType<typeof admin>>;
beforeAll(async () => { A = await admin(); });
afterAll(closeAll);

async function table(n: number) {
  const players: User[] = [];
  for (let i = 0; i < n; i++) players.push(await user());
  const room: string = await players[0].rpc("create_room");
  for (const p of players.slice(1)) await p.rpc("join_room", room);
  return { room, players };
}
const shooterId = async (room: string) =>
  (await A.one(`select s.player_id from public.seats s join public.rooms r on r.id = s.room_id and r.shooter_seat = s.seat_no
                where r.id = $1`, [room]))?.player_id as string | undefined;
const roll = (u: User, room: string, d1: number, d2: number) => u.rpc("roll_dice", room, "godice", d1, d2);

describe("security: clients are read-only", () => {
  it("cannot write any table directly", async () => {
    const { room, players: [p] } = await table(1);
    await rejects(p.c.query(`update public.players set balance = 999999 where id = $1`, [p.id]), /permission denied/);
    await rejects(p.c.query(`update public.rooms set phase_deadline = now() + interval '1 hour' where id = $1`, [room]), /permission denied/);
    await rejects(p.c.query(`insert into public.bets (room_id, hand_no, placed_before_roll, player_id, side, amount, status)
                             values ($1, 1, 0, $2, 'with', 10, 'won')`, [room, p.id]), /permission denied/);
    await rejects(p.c.query(`delete from public.events where room_id = $1`, [room]), /permission denied/);
  });
  it("cannot reach engine internals or server-only roll sources", async () => {
    const { room, players: [p] } = await table(1);
    await rejects(p.c.query(`select engine.tick_all()`), /permission denied/);
    await rejects(p.c.query(`select engine.do_bet($1, $2, 'with', 10)`, [room, p.id]), /permission denied/);
    await rejects(p.rpc("roll_dice", room, "auto", null, null), "BAD_SOURCE");
  });
  it("cannot see another player's play ledger", async () => {
    const { room, players: [p, q] } = await table(2);
    await q.rpc("place_bet", room, "against", 50);
    const rows = (await p.c.query(`select * from public.play_ledger`)).rows;
    expect(rows.every((r) => r.player_id === p.id)).toBe(true);
  });
});

describe("turn order", () => {
  it("only the shooter rolls, and the dice pass seat to seat", async () => {
    const { room, players: [a, b, c] } = await table(3);
    expect(await shooterId(room)).toBe(a.id);
    await rejects(roll(b, room, 3, 4), "NOT_YOUR_TURN");

    await roll(a, room, 3, 4);                           // natural 7: hand over
    await rejects(roll(a, room, 3, 4), "NOT_YOUR_TURN"); // can't roll during the catch window
    await A.expire(room);
    expect(await shooterId(room)).toBe(b.id);

    await roll(b, room, 1, 1); await A.expire(room);     // snake eyes: craps, hand over
    expect(await shooterId(room)).toBe(c.id);

    await roll(c, room, 2, 2); await A.expire(room);     // point 4: same shooter
    expect((await A.room(room)).point).toBe(4);
    expect(await shooterId(room)).toBe(c.id);
    await roll(c, room, 3, 1); await A.expire(room);     // hit the 4
    expect(await shooterId(room)).toBe(a.id);            // wraps back to seat 0
    expect((await A.room(room)).hand_no).toBe(4);
  });
});

describe("betting and payouts", () => {
  it("settles even money against and with the shooter", async () => {
    const { room, players: [a, b, c] } = await table(3);
    await a.rpc("place_bet", room, "with", 100);
    await b.rpc("place_bet", room, "against", 100);
    await c.rpc("place_bet", room, "with", 50);
    expect(await A.balance(b.id)).toBe(900);             // stake leaves the balance immediately
    await roll(a, room, 5, 6); await A.expire(room);     // yo-leven
    expect(await A.balance(a.id)).toBe(1100);
    expect(await A.balance(b.id)).toBe(900);
    expect(await A.balance(c.id)).toBe(1050);
  });

  it("seven-out pays the faders", async () => {
    const { room, players: [a, b] } = await table(2);
    await roll(a, room, 4, 4); await A.expire(room);     // point 8
    await b.rpc("place_bet", room, "against", 200);
    await roll(a, room, 2, 1); await A.expire(room);     // 3 in point phase: roll again
    expect((await A.room(room)).phase).toBe("betting");
    await roll(a, room, 6, 1); await A.expire(room);     // seven out
    expect(await A.balance(b.id)).toBe(1200);
    const payout = (await A.events(room)).find((e) => e.kind === "payout" && e.actor_id === b.id);
    expect(payout?.data).toMatchObject({ staked: 200, paid: 400, net: 200 });
  });

  it("stakes lock when the roll starts", async () => {
    const { room, players: [a, b] } = await table(2);
    await b.rpc("place_bet", room, "against", 100);
    await roll(a, room, 2, 2);
    await rejects(b.rpc("place_bet", room, "against", 50), "BETTING_CLOSED");
    await rejects(b.rpc("clear_bets", room), "BETTING_CLOSED");
    const bet = await A.one(`select status from public.bets where room_id = $1 and player_id = $2`, [room, b.id]);
    expect(bet.status).toBe("locked");
  });

  it("validates side, amount, balance and one side per hand", async () => {
    const { room, players: [a, b] } = await table(2);
    await rejects(a.rpc("place_bet", room, "against", 100), "SHOOTER_BETS_WITH");
    await rejects(b.rpc("place_bet", room, "against", 5), "BAD_AMOUNT");
    await rejects(b.rpc("place_bet", room, "sideways", 50), "BAD_SIDE");
    await b.rpc("place_bet", room, "against", 1000);
    await rejects(b.rpc("place_bet", room, "against", 10), "INSUFFICIENT_COINS");
    await b.rpc("clear_bets", room);                     // refunded before the roll
    expect(await A.balance(b.id)).toBe(1000);
    await b.rpc("place_bet", room, "with", 10);
    await rejects(b.rpc("place_bet", room, "against", 10), "ONE_SIDE_PER_HAND");
  });

  it("watchers (not seated) cannot bet or roll", async () => {
    const { room } = await table(1);
    const w = await user();
    await rejects(w.rpc("place_bet", room, "against", 50), "NOT_SEATED");
    await rejects(w.rpc("call_catch", room, "cocked"), /CATCH_WINDOW_CLOSED|NOT_SEATED/);
  });
});

describe("virtual dice are server-generated", () => {
  it("ignores any faces a client sends with a virtual roll", async () => {
    const { room, players: [a] } = await table(1);
    const totals: number[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await a.rpc("roll_dice", room, "virtual", 6, 6);
      const r = await A.one(`select d1, d2, source from public.rolls where id = $1`, [id]);
      expect(r.source).toBe("virtual");
      totals.push(r.d1 + r.d2);
      await A.expire(room);
    }
    expect(totals.every((t) => t === 12)).toBe(false);
  });
  it("engine.die() is uniform", async () => {
    const rows = await A.q(`select engine.die() f, count(*)::int n from generate_series(1, 12000) group by 1 order by 1`);
    expect(rows.map((r) => r.f)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const r of rows) { expect(r.n).toBeGreaterThan(1750); expect(r.n).toBeLessThan(2250); }
  });
  it("rejects impossible physical-dice faces", async () => {
    const { room, players: [a] } = await table(1);
    await rejects(roll(a, room, 0, 7), "BAD_DICE");
  });
});

describe("catch voting", () => {
  it("a majority of the other seated players voids the roll and the shooter rerolls", async () => {
    const { room, players: [a, b, c, d] } = await table(4);
    await b.rpc("place_bet", room, "against", 100);
    await roll(a, room, 6, 6);                           // boxcars... unless it's caught
    await rejects(a.rpc("call_catch", room, "cocked"), "SHOOTER_CANNOT_CATCH");
    await b.rpc("call_catch", room, "off_table");        // 1 of 3
    await rejects(c.rpc("call_catch", room, "cocked"), "CATCH_ALREADY_CALLED");
    await rejects(b.rpc("vote_catch", room, true), "ALREADY_VOTED");
    expect(await c.rpc("vote_catch", room, true)).toBe("upheld"); // 2 of 3
    const r = await A.room(room);
    expect(r.phase).toBe("reroll");
    expect((await A.one(`select status from public.rolls where room_id = $1 order by id desc limit 1`, [room])).status).toBe("void");
    await rejects(d.rpc("vote_catch", room, false), "NO_OPEN_CATCH");
    await rejects(b.rpc("place_bet", room, "against", 10), "BETTING_CLOSED"); // stakes stay locked for the reroll
    await roll(a, room, 3, 4); await A.expire(room);     // reroll: natural 7
    expect(await A.balance(b.id)).toBe(900);
    const kinds = (await A.events(room)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["catch_call", "catch_vote", "catch_upheld"]));
  });

  it("rejects as soon as a majority is out of reach, and the roll stands", async () => {
    const { room, players: [a, b, c, d] } = await table(4);
    await roll(a, room, 1, 1);
    await b.rpc("call_catch", room, "cocked");
    expect(await c.rpc("vote_catch", room, false)).toBe("open");
    expect(await d.rpc("vote_catch", room, false)).toBe("rejected");
    expect(await shooterId(room)).toBe(b.id);           // craps stood, dice passed
  });

  it("an unanswered catch closes at the server deadline with non-voters as no", async () => {
    const { room, players: [a, b] } = await table(3);
    await roll(a, room, 2, 3);
    await b.rpc("call_catch", room, "bad_throw");       // 1 of 2: open
    expect((await A.room(room)).phase).toBe("catch_vote");
    await A.expire(room);
    expect((await A.room(room)).point).toBe(5);
    expect((await A.events(room)).some((e) => e.kind === "catch_rejected")).toBe(true);
  });

  it("catch can only be called inside the 5s window", async () => {
    const { room, players: [a, b] } = await table(2);
    await roll(a, room, 2, 3);
    await A.c.query(`update public.rooms set phase_deadline = now() - interval '1 ms' where id = $1`, [room]);
    await rejects(b.rpc("call_catch", room, "cocked"), "CATCH_WINDOW_CLOSED");
  });

  it("bots vote through the same functions, so a solo player can win a catch", async () => {
    const solo = await user();
    const room: string = await solo.rpc("create_room");
    expect(await solo.rpc("fill_bots", room, 3)).toBe(3);
    let upheld = 0, rejected = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      // get the dice to a bot
      for (let guard = 0; guard < 20 && (await shooterId(room)) === solo.id; guard++) {
        const r = await A.room(room);
        if (r.phase === "betting" || r.phase === "reroll") await roll(solo, room, 3, 4);
        await A.expire(room);
      }
      // let the bot shooter roll (bots act after their phase ages)
      for (let guard = 0; guard < 30 && (await A.room(room)).phase !== "catch_window"; guard++) {
        await A.age(room, 5); await A.tick(room);
      }
      expect((await A.room(room)).phase).toBe("catch_window");
      await solo.rpc("call_catch", room, "cocked");     // solo + 2 bots eligible: needs one bot to agree
      for (let guard = 0; guard < 40 && (await A.room(room)).phase === "catch_vote"; guard++) {
        await A.age(room, 2); await A.tick(room);
      }
      const last = await A.one(`select status, id from public.catches where room_id = $1 order by id desc limit 1`, [room]);
      if (last.status === "upheld") upheld++; else rejected++;
      const voters = await A.q(`select v.voter_id, p.is_bot from public.catch_votes v join public.players p on p.id = v.voter_id
                                where catch_id = $1`, [last.id]);
      expect(voters.some((v) => v.is_bot)).toBe(true);
      expect(new Set(voters.map((v) => v.voter_id)).size).toBe(voters.length); // one vote each
      if (upheld && rejected) break;
      await A.expire(room);                              // move on from the reroll / next roll
    }
    expect(upheld).toBeGreaterThan(0);                  // P(no upheld in 12) ≈ (1/4)^12
  });
});

describe("disconnects", () => {
  it("holds the seat for 30s and a rejoin restores seat and balance", async () => {
    const { room, players: [a, b] } = await table(2);
    await b.rpc("place_bet", room, "against", 150);
    const seat = (await A.one(`select seat_no from public.seats where player_id = $1`, [b.id])).seat_no;
    await A.c.query(`update public.seats set last_seen = now() - interval '9 s' where player_id = $1`, [b.id]);
    await A.tick(room);
    const away = await A.one(`select status, hold_until > now() + interval '25 s' as held from public.seats where player_id = $1`, [b.id]);
    expect(away).toEqual({ status: "away", held: true });
    expect(await b.rpc("join_room", room)).toBe(seat);   // same seat back
    expect((await A.one(`select status from public.seats where player_id = $1`, [b.id])).status).toBe("active");
    expect(await A.balance(b.id)).toBe(850);
    const kinds = (await A.events(room)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["disconnect", "reconnect"]));
    void a;
  });

  it("releases the seat after the hold, refunding open bets", async () => {
    const { room, players: [, b] } = await table(2);
    await b.rpc("place_bet", room, "against", 150);
    await A.c.query(`update public.seats set status = 'away', hold_until = now() - interval '1 ms' where player_id = $1`, [b.id]);
    await A.tick(room);
    expect(await A.q(`select 1 from public.seats where player_id = $1`, [b.id])).toHaveLength(0);
    expect(await A.balance(b.id)).toBe(1000);
    expect((await A.events(room)).some((e) => e.kind === "seat_released")).toBe(true);
  });

  it("auto-skips a shooter who is gone, voiding an unfinished hand", async () => {
    const { room, players: [a, b] } = await table(2);
    await roll(a, room, 3, 3); await A.expire(room);    // point 6, a still shooting
    await b.rpc("place_bet", room, "against", 100);
    await A.c.query(`update public.seats set last_seen = now() - interval '9 s' where player_id = $1`, [a.id]);
    await A.tick(room);
    expect(await shooterId(room)).toBe(b.id);
    expect((await A.room(room)).point).toBeNull();
    expect(await A.balance(b.id)).toBe(1000);           // refunded
    expect((await A.events(room)).some((e) => e.kind === "hand_void")).toBe(true);
  });
});

describe("timers are server-owned", () => {
  it("an idle shooter's shot clock expires and the server rolls for them", async () => {
    const { room, players: [a] } = await table(1);
    await A.expire(room);
    const r = await A.one(`select source, shooter_id from public.rolls where room_id = $1 order by id desc limit 1`, [room]);
    expect(r).toEqual({ source: "auto", shooter_id: a.id });
  });
  it("client calls never move a deadline", async () => {
    const { room, players: [a, b] } = await table(2);
    await roll(a, room, 2, 3);
    const before = (await A.room(room)).phase_deadline.getTime();
    for (let i = 0; i < 3; i++) { await b.rpc("heartbeat", room); await a.rpc("heartbeat", room); }
    const after = await A.room(room);
    expect(after.phase).toBe("catch_window");
    expect(after.phase_deadline.getTime()).toBe(before);
  });
});

describe("play limits", () => {
  it("enforces a configurable daily coin-play cap", async () => {
    const { room, players: [a, b] } = await table(2);
    await b.rpc("set_daily_cap", 150);
    await b.rpc("place_bet", room, "against", 100);
    await rejects(b.rpc("place_bet", room, "against", 60), "DAILY_CAP");
    await b.rpc("clear_bets", room);                     // refunds give play back
    await b.rpc("place_bet", room, "against", 150);
    const st = await b.rpc("my_status");
    expect(st).toMatchObject({ daily_cap: 150, played_today: 150 });
    await rejects(b.rpc("set_daily_cap", 50), "BAD_AMOUNT");
    void a;
  });
});

describe("hand history", () => {
  it("records every roll, bet, payout and catch with timestamps", async () => {
    const { room, players: [a, b, c] } = await table(3);
    await b.rpc("place_bet", room, "against", 40);
    await roll(a, room, 1, 2);
    await b.rpc("call_catch", room, "cocked");
    await c.rpc("vote_catch", room, false);
    await A.expire(room);
    const ev = await A.events(room);
    const kinds = ev.map((e) => e.kind);
    for (const k of ["join", "new_hand", "bet", "roll", "catch_call", "catch_vote", "catch_rejected", "roll_result", "hand_end", "payout"])
      expect(kinds).toContain(k);
    expect(ev.every((e) => e.created_at instanceof Date)).toBe(true);
    expect(ev.find((e) => e.kind === "roll")?.data).toMatchObject({ d1: 1, d2: 2, total: 3, source: "godice" });
  });
});
