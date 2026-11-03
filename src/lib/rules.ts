/**
 * SNAKEYES street-dice rules — the one place the game's rules live in TypeScript.
 *
 * The authoritative copy runs in Postgres (`public.rules_resolve_roll`, `public.rules_settle_bet`,
 * see supabase/migrations). `tests/db/parity.test.ts` runs every input through both
 * implementations and fails if they ever disagree, so the UI can never explain a roll
 * differently from how the server settled it.
 */

export const RULES = {
  maxSeats: 8,
  startingCoins: 1000,
  minBet: 10,
  maxBet: 1000,
  catchWindowSec: 5, // after a roll, other players may call "catch" for this long
  catchVoteSec: 6, // once called, voting closes this long after the call
  shotClockSec: 25, // shooter must roll within this, else the server rolls for them
  disconnectAfterSec: 8, // no heartbeat for this long => seat marked away
  seatHoldSec: 30, // away seat is held this long before it is released
  defaultDailyCap: 5000,
} as const;

export type Side = "with" | "against"; // with = backing the shooter, against = fading the shooter
export type RollOutcome = "win" | "lose" | "point" | "continue";
export type HandResult = "win" | "lose";

export interface RollResolution {
  outcome: RollOutcome;
  /** the point after this roll (null on a come-out that resolves the hand) */
  point: number | null;
}

export function isDie(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 6;
}

/**
 * Resolve a roll total against the current point.
 * Come-out (point = null): 7/11 win, 2/3/12 lose, anything else becomes the point.
 * Point phase: hitting the point wins, a 7 loses, anything else rolls again.
 */
export function resolveRoll(point: number | null, total: number): RollResolution {
  if (!Number.isInteger(total) || total < 2 || total > 12) throw new RangeError(`bad total ${total}`);
  if (point === null) {
    if (total === 7 || total === 11) return { outcome: "win", point: null };
    if (total === 2 || total === 3 || total === 12) return { outcome: "lose", point: null };
    return { outcome: "point", point: total };
  }
  if (![4, 5, 6, 8, 9, 10].includes(point)) throw new RangeError(`bad point ${point}`);
  if (total === point) return { outcome: "win", point };
  if (total === 7) return { outcome: "lose", point };
  return { outcome: "continue", point };
}

/** Coins credited back for a bet when the hand ends (stake is debited when placed). Even money. */
export function settleBet(side: Side, amount: number, result: HandResult): number {
  const won = (side === "with" && result === "win") || (side === "against" && result === "lose");
  return won ? amount * 2 : 0;
}

/** Catch votes: upheld when a strict majority of eligible voters (seated, non-shooter) agree. */
export type CatchVerdict = "upheld" | "rejected" | "open";
export function catchVerdict(eligible: number, agree: number, disagree: number, closed: boolean): CatchVerdict {
  if (eligible <= 0) return "rejected";
  if (agree * 2 > eligible) return "upheld";
  const undecided = eligible - agree - disagree;
  if ((agree + undecided) * 2 <= eligible) return "rejected"; // majority no longer reachable
  return closed ? "rejected" : "open";
}

/** Next shooter: the next occupied, present seat after `current`, wrapping. */
export function nextShooter(seats: { seatNo: number; present: boolean }[], current: number | null): number | null {
  const present = seats.filter((s) => s.present).map((s) => s.seatNo).sort((a, b) => a - b);
  if (present.length === 0) return null;
  if (current === null) return present[0];
  return present.find((n) => n > current) ?? present[0];
}

/** Can this bet be placed? Mirrors the checks in `engine.do_bet` so the UI can disable chips early. */
export type BetError =
  | "BETTING_CLOSED" | "NOT_SEATED" | "BAD_AMOUNT" | "INSUFFICIENT_COINS"
  | "DAILY_CAP" | "SHOOTER_BETS_WITH" | "ONE_SIDE_PER_HAND";
export function checkBet(o: {
  phase: string; seated: boolean; isShooter: boolean; side: Side; amount: number;
  balance: number; playedToday: number; dailyCap: number; sideThisHand: Side | null;
}): BetError | null {
  if (o.phase !== "betting") return "BETTING_CLOSED";
  if (!o.seated) return "NOT_SEATED";
  if (!Number.isInteger(o.amount) || o.amount < RULES.minBet || o.amount > RULES.maxBet) return "BAD_AMOUNT";
  if (o.isShooter && o.side !== "with") return "SHOOTER_BETS_WITH";
  if (o.sideThisHand && o.sideThisHand !== o.side) return "ONE_SIDE_PER_HAND";
  if (o.amount > o.balance) return "INSUFFICIENT_COINS";
  if (o.playedToday + o.amount > o.dailyCap) return "DAILY_CAP";
  return null;
}

export function describeRoll(point: number | null, d1: number, d2: number): string {
  const total = d1 + d2;
  const r = resolveRoll(point, total);
  if (point === null) {
    if (r.outcome === "win") return total === 7 ? "Seven! Natural winner" : "Yo-leven! Natural winner";
    if (r.outcome === "lose") return total === 2 ? "Snake eyes. Craps" : total === 3 ? "Ace-deuce. Craps" : "Boxcars. Craps";
    return `Point is ${total}`;
  }
  if (r.outcome === "win") return `Hit the ${point}! Shooter wins`;
  if (r.outcome === "lose") return "Seven out";
  return `${total}. Roll again for the ${point}`;
}

export const ERROR_COPY: Record<string, string> = {
  BETTING_CLOSED: "Bets are locked. Wait for the next roll.",
  NOT_SEATED: "Take a seat to play.",
  BAD_AMOUNT: `Bets are ${RULES.minBet}–${RULES.maxBet} coins.`,
  INSUFFICIENT_COINS: "Not enough coins.",
  DAILY_CAP: "You've reached today's play limit.",
  SHOOTER_BETS_WITH: "The shooter can only back themselves.",
  ONE_SIDE_PER_HAND: "You already picked a side this hand.",
  NOT_YOUR_TURN: "It's not your roll.",
  CATCH_WINDOW_CLOSED: "Too late to call catch.",
  SHOOTER_CANNOT_CATCH: "The shooter can't call catch on themselves.",
  ALREADY_VOTED: "You already voted.",
  NO_OPEN_CATCH: "There's no catch to vote on.",
  ROOM_FULL: "Table is full. Joining as a watcher.",
  NO_ROOM: "That table doesn't exist.",
  NOT_SIGNED_IN: "Sign in first.",
  NAME_TAKEN: "That name is taken.",
  BAD_NAME: "Names are 2–16 letters, numbers or _.",
  CATCH_ALREADY_CALLED: "Catch already called on this roll.",
  BAD_DICE: "Dice values must be 1–6.",
  NO_REFILL: "Refills unlock when you're under 100 coins (once an hour).",
};
