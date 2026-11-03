"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sb, type Me } from "./supabase";

export type Phase = "idle" | "betting" | "catch_window" | "catch_vote" | "reroll";
export interface RoomRow {
  id: string; phase: Phase; hand_no: number; roll_seq: number; shooter_seat: number | null; point: number | null;
  phase_started_at: string; phase_deadline: string | null; current_roll_id: number | null; created_by: string;
}
export interface SeatRow {
  seat_no: number; player_id: string; is_bot: boolean; status: "active" | "away"; hold_until: string | null;
  player: { id: string; username: string; balance: number; is_bot: boolean };
}
export interface BetRow { id: number; player_id: string; side: "with" | "against"; amount: number; status: string; hand_no: number }
export interface EventRow { id: number; created_at: string; hand_no: number | null; kind: string; actor_id: string | null; actor_name: string | null; data: Record<string, unknown> }
export interface RollRow { id: number; d1: number; d2: number; source: string; status: string; shooter_id: string; created_at: string }
export interface CatchRow { id: number; caller_id: string; reason: string; eligible: number; vote_deadline: string; status: string; roll_id: number }
export interface VoteRow { voter_id: string; agree: boolean }

export interface RoomState {
  room: RoomRow | null;
  seats: SeatRow[];
  bets: BetRow[];
  events: EventRow[];
  lastRoll: RollRow | null;
  openCatch: CatchRow | null;
  votes: VoteRow[];
  me: Me | null;
}

const EMPTY: RoomState = { room: null, seats: [], bets: [], events: [], lastRoll: null, openCatch: null, votes: [], me: null };

/** Live view of one table. Reads only: every write goes through RPCs. */
export function useRoom(code: string, enabled: boolean) {
  const [state, setState] = useState<RoomState>(EMPTY);
  const [missing, setMissing] = useState(false);
  const [skew, setSkew] = useState(0); // serverNow - clientNow (ms)
  const inflight = useRef(false);
  const again = useRef(false);

  const refetch = useCallback(async () => {
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      const s = sb();
      const { data: room } = await s.from("rooms").select("*").eq("id", code).maybeSingle();
      if (!room) { setMissing(true); return; }
      const [seats, bets, events, roll, me] = await Promise.all([
        s.from("seats").select("seat_no, player_id, is_bot, status, hold_until, player:players(id, username, balance, is_bot)")
          .eq("room_id", code).order("seat_no"),
        s.from("bets").select("id, player_id, side, amount, status, hand_no").eq("room_id", code).eq("hand_no", room.hand_no),
        s.from("events").select("*").eq("room_id", code).order("id", { ascending: false }).limit(120),
        s.from("rolls").select("*").eq("room_id", code).order("id", { ascending: false }).limit(1).maybeSingle(),
        s.rpc("my_status"),
      ]);
      let openCatch: CatchRow | null = null;
      let votes: VoteRow[] = [];
      if (room.phase === "catch_vote" && room.current_roll_id) {
        const { data: c } = await s.from("catches").select("*").eq("roll_id", room.current_roll_id).maybeSingle();
        openCatch = c as CatchRow | null;
        if (c) votes = ((await s.from("catch_votes").select("voter_id, agree").eq("catch_id", c.id)).data ?? []) as VoteRow[];
      }
      setState({
        room: room as RoomRow,
        seats: (seats.data ?? []) as unknown as SeatRow[],
        bets: (bets.data ?? []) as BetRow[],
        events: (events.data ?? []) as EventRow[],
        lastRoll: (roll.data ?? null) as RollRow | null,
        openCatch, votes,
        me: (me.data ?? null) as Me | null,
      });
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; void refetch(); }
    }
  }, [code]);

  // realtime: any change to the room, its seats or its history -> refetch (coalesced)
  useEffect(() => {
    if (!enabled) return;
    const s = sb();
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (t) return; t = setTimeout(() => { t = null; void refetch(); }, 60); };
    const ch = s.channel(`room:${code}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${code}` }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `room_id=eq.${code}` }, bump)
      .on("postgres_changes", { event: "*", schema: "public", table: "seats", filter: `room_id=eq.${code}` }, bump)
      .subscribe();
    void refetch();
    const poll = setInterval(() => void refetch(), 5000); // safety net if a realtime message is missed
    return () => { if (t) clearTimeout(t); clearInterval(poll); void s.removeChannel(ch); };
  }, [code, enabled, refetch]);

  // heartbeat: keeps my seat, lets the server notice deadlines even between cron ticks, syncs the clock
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const beat = async () => {
      const t0 = Date.now();
      const { data } = await sb().rpc("heartbeat", { p_room: code });
      const t1 = Date.now();
      if (!stopped && data?.now) setSkew(new Date(data.now).getTime() - (t0 + t1) / 2);
    };
    void beat();
    const h = setInterval(beat, 4000);
    const onVis = () => { if (document.visibilityState === "visible") void beat(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; clearInterval(h); document.removeEventListener("visibilitychange", onVis); };
  }, [code, enabled]);

  return { ...state, missing, refetch, skew };
}

/** Re-render on an interval (for countdowns) without touching layout. */
export function useNow(ms = 250) {
  const [now, set] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => set(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return now;
}
