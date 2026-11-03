import { describe, expect, it } from "vitest";
import { catchVerdict, checkBet, describeRoll, nextShooter, resolveRoll, RULES, settleBet } from "./rules";

describe("resolveRoll — come-out", () => {
  it.each([7, 11])("%i is a natural win", (t) => expect(resolveRoll(null, t)).toEqual({ outcome: "win", point: null }));
  it.each([2, 3, 12])("%i is craps", (t) => expect(resolveRoll(null, t)).toEqual({ outcome: "lose", point: null }));
  it.each([4, 5, 6, 8, 9, 10])("%i becomes the point", (t) => expect(resolveRoll(null, t)).toEqual({ outcome: "point", point: t }));
});

describe("resolveRoll — point phase", () => {
  it("hitting the point wins", () => expect(resolveRoll(6, 6).outcome).toBe("win"));
  it("a 7 loses (seven-out)", () => expect(resolveRoll(6, 7).outcome).toBe("lose"));
  it("11 and craps numbers just roll again", () => {
    for (const t of [2, 3, 11, 12, 4, 8]) expect(resolveRoll(6, t)).toEqual({ outcome: "continue", point: 6 });
  });
  it("rejects impossible totals and points", () => {
    expect(() => resolveRoll(null, 1)).toThrow();
    expect(() => resolveRoll(null, 13)).toThrow();
    expect(() => resolveRoll(7, 7)).toThrow();
  });
});

describe("settleBet — even money", () => {
  it("backing the shooter pays on a win", () => {
    expect(settleBet("with", 100, "win")).toBe(200);
    expect(settleBet("with", 100, "lose")).toBe(0);
  });
  it("fading the shooter pays on a loss", () => {
    expect(settleBet("against", 50, "lose")).toBe(100);
    expect(settleBet("against", 50, "win")).toBe(0);
  });
});

describe("catchVerdict — strict majority of eligible voters", () => {
  it("solo caller among one eligible voter upholds", () => expect(catchVerdict(1, 1, 0, false)).toBe("upheld"));
  it("1 of 3 is still open, 2 of 3 upholds", () => {
    expect(catchVerdict(3, 1, 0, false)).toBe("open");
    expect(catchVerdict(3, 2, 0, false)).toBe("upheld");
  });
  it("rejects early once a majority is unreachable", () => expect(catchVerdict(3, 1, 2, false)).toBe("rejected"));
  it("a tie is not a majority", () => {
    expect(catchVerdict(4, 2, 2, false)).toBe("rejected");
    expect(catchVerdict(4, 2, 0, true)).toBe("rejected");
  });
  it("non-voters count as no when the vote closes", () => expect(catchVerdict(5, 2, 0, true)).toBe("rejected"));
});

describe("nextShooter", () => {
  const seats = [0, 2, 5].map((seatNo) => ({ seatNo, present: true }));
  it("rotates in seat order and wraps", () => {
    expect(nextShooter(seats, null)).toBe(0);
    expect(nextShooter(seats, 0)).toBe(2);
    expect(nextShooter(seats, 2)).toBe(5);
    expect(nextShooter(seats, 5)).toBe(0);
  });
  it("skips away seats", () => expect(nextShooter([{ seatNo: 1, present: false }, { seatNo: 3, present: true }], 0)).toBe(3));
  it("returns null for an empty table", () => expect(nextShooter([], 0)).toBeNull());
});

describe("checkBet", () => {
  const base = { phase: "betting", seated: true, isShooter: false, side: "against" as const, amount: 100,
    balance: 1000, playedToday: 0, dailyCap: RULES.defaultDailyCap, sideThisHand: null };
  it("accepts a normal bet", () => expect(checkBet(base)).toBeNull());
  it("locks bets outside the betting phase", () => expect(checkBet({ ...base, phase: "catch_window" })).toBe("BETTING_CLOSED"));
  it("watchers can't bet", () => expect(checkBet({ ...base, seated: false })).toBe("NOT_SEATED"));
  it("shooter only backs themselves", () => expect(checkBet({ ...base, isShooter: true })).toBe("SHOOTER_BETS_WITH"));
  it("enforces the daily cap", () => expect(checkBet({ ...base, playedToday: 4950 })).toBe("DAILY_CAP"));
  it("enforces balance", () => expect(checkBet({ ...base, balance: 50 })).toBe("INSUFFICIENT_COINS"));
  it("one side per hand", () => expect(checkBet({ ...base, sideThisHand: "with" })).toBe("ONE_SIDE_PER_HAND"));
  it("bounds amounts", () => {
    expect(checkBet({ ...base, amount: 5 })).toBe("BAD_AMOUNT");
    expect(checkBet({ ...base, amount: 1001 })).toBe("BAD_AMOUNT");
  });
});

describe("describeRoll", () => {
  it("names the classics", () => {
    expect(describeRoll(null, 1, 1)).toMatch(/Snake eyes/);
    expect(describeRoll(null, 5, 6)).toMatch(/leven/);
    expect(describeRoll(8, 3, 4)).toBe("Seven out");
    expect(describeRoll(null, 2, 2)).toBe("Point is 4");
  });
});
