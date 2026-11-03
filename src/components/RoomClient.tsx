"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LiveKitRoom, RoomAudioRenderer, useDataChannel, useTrackToggle } from "@livekit/components-react";
import { Track, VideoPresets } from "livekit-client";
import { ensureSession, GameError, myStatus, rpc, sb } from "@/lib/supabase";
import { useNow, useRoom, type EventRow } from "@/lib/useRoom";
import { checkBet, describeRoll, ERROR_COPY, RULES, type Side } from "@/lib/rules";
import { VirtualDice } from "@/lib/dice/virtual";
import { GoDiceWeb } from "@/lib/dice/godice";
import type { DiceState, RollIntent } from "@/lib/dice/adapter";
import { Logo } from "./Logo";
import { SignIn } from "./SignIn";
import { Dice3D } from "./Dice3D";
import { VideoGrid, type TileDelta } from "./VideoGrid";
import { ChatPanel, EMOJIS, GoDicePanel, HistoryPanel, LimitsPanel, ReactionLayer, SharePanel, Sheet, type Floater } from "./Panels";

const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch {} };
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Stage = "auth" | "signin" | "joining" | "ready" | "missing";

export function RoomClient({ code, watchParam, botsParam, remindSec }: { code: string; watchParam: boolean; botsParam: boolean; remindSec: number }) {
  const [stage, setStage] = useState<Stage>("auth");
  const [watch, setWatch] = useState(watchParam);
  const [lk, setLk] = useState<{ token: string; url: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  const enter = useCallback(async () => {
    setStage("joining");
    let w = watchParam;
    if (!w) {
      try { await rpc("join_room", { p_room: code }); }
      catch (e) {
        const m = e instanceof GameError ? e.message : "";
        if (m === "NO_ROOM") { setStage("missing"); return; }
        if (m === "ROOM_FULL") { w = true; setNotice(ERROR_COPY.ROOM_FULL); }
        else throw e;
      }
    }
    if (!w && botsParam) {
      const { data } = await sb().from("seats").select("is_bot").eq("room_id", code);
      if (!data?.some((s) => s.is_bot)) { try { await rpc("fill_bots", { p_room: code, p_count: 3 }); } catch {} }
    }
    setWatch(w);
    try {
      const session = await ensureSession();
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ room: code, watch: w }),
      });
      if (res.ok) setLk(await res.json());
      else setNotice("Video is unavailable right now. The game still works.");
    } catch { setNotice("Video is unavailable right now. The game still works."); }
    setStage("ready");
  }, [code, watchParam, botsParam]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await ensureSession();
        const me = await myStatus();
        if (!me) setStage("signin"); else await enter();
      } catch { setStage("signin"); }
    })();
  }, [enter]);

  if (stage === "missing") {
    return (
      <main className="shell" style={{ maxWidth: 480, paddingTop: 40 }}>
        <Logo />
        <h1 className="display" style={{ fontSize: 48, margin: "30px 0 10px" }}>No table {code}</h1>
        <p className="muted">That code doesn&apos;t match an open table.</p>
        <Link className="btn btn-acid" href="/">Start a new table</Link>
      </main>
    );
  }
  if (stage !== "ready") {
    return (
      <main className="shell" style={{ maxWidth: 480, paddingTop: 22 }}>
        <Logo />
        <h1 className="display" style={{ fontSize: 44, margin: "28px 0 6px" }}>
          {watchParam ? "Watch" : "Join"} table <span style={{ color: "var(--acid)" }}>{code}</span>
        </h1>
        <p className="muted" style={{ marginTop: 0 }}>{botsParam ? "Bots will fill the empty seats." : "Live video street dice. Free coins only."}</p>
        <div className="card" style={{ padding: 18, minHeight: 210 }}>
          {stage === "signin" ? <SignIn onDone={() => void enter()} cta={watchParam ? "Watch" : "Take a seat"} />
            : <div className="muted" style={{ height: 180, display: "grid", placeItems: "center" }}>Pulling up a chair…</div>}
        </div>
      </main>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={lk?.url}
      token={lk?.token}
      connect={!!lk}
      video={!watch}
      audio={!watch}
      options={{ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: VideoPresets.h360.resolution, facingMode: "user" } }}
      onMediaDeviceFailure={() => setNotice("Camera or mic is blocked. You can still play. Check browser permissions.")}
      onError={() => setNotice("Video connection hiccup. Retrying…")}
      style={{ display: "contents" }}
    >
      <Table code={code} watch={watch} remindSec={remindSec} notice={notice} clearNotice={() => setNotice(null)} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

/* ═══════════════════════════ the table ═══════════════════════════ */

function Table({ code, watch, remindSec, notice, clearNotice }: { code: string; watch: boolean; remindSec: number; notice: string | null; clearNotice: () => void }) {
  const router = useRouter();
  const R = useRoom(code, true);
  const clientNow = useNow(250);
  const [limits, setLimits] = useState<null | "time" | "cap80" | "cap" | "manual">(null);
  const { room, seats, bets, events, lastRoll, openCatch, votes, me, skew } = R;

  const mySeat = me ? seats.find((s) => s.player_id === me.id) ?? null : null;
  const shooter = room?.shooter_seat != null ? seats.find((s) => s.seat_no === room.shooter_seat) ?? null : null;
  const isShooter = !!mySeat && room?.shooter_seat === mySeat.seat_no;

  /* ── toasts / overlays ── */
  const [toast, setToast] = useState<string | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: string) => {
    setToast(t);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(null), 2600);
  }, []);
  // a notice from the outer component (video failure etc.) becomes a toast once
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (notice) { say(notice); clearNotice(); } }, [notice, say, clearNotice]);

  const fail = useCallback((e: unknown) => {
    const m = e instanceof GameError ? e.message : "";
    if (m === "DAILY_CAP") { setLimits("cap"); buzz(60); return; }
    say(ERROR_COPY[m] ?? "That didn't go through. Try again.");
    buzz([20, 40, 20]);
  }, [say]);

  /* ── dice adapters ── */
  const [virtualDice] = useState(() => new VirtualDice());
  const [goDice] = useState(() => new GoDiceWeb());
  const [diceMode, setDiceMode] = useState<"virtual" | "godice">("virtual");
  const [goState, setGoState] = useState<DiceState>({ kind: "disconnected" });
  const [shake, setShake] = useState(false);
  const [tumbling, setTumbling] = useState(false);
  const tumbleSince = useRef(0);
  const turnRef = useRef({ isShooter, phase: room?.phase });
  useEffect(() => { turnRef.current = { isShooter, phase: room?.phase }; }, [isShooter, room?.phase]);

  const submitRoll = useCallback(async (intent: RollIntent) => {
    const t = turnRef.current;
    if (!t.isShooter || (t.phase !== "betting" && t.phase !== "reroll")) { setTumbling(false); say(ERROR_COPY.NOT_YOUR_TURN); return; }
    buzz(15);
    try {
      await rpc("roll_dice", intent.source === "godice"
        ? { p_room: code, p_source: "godice", p_d1: intent.d1, p_d2: intent.d2 }
        : { p_room: code, p_source: "virtual" });
      void R.refetch();
    } catch (e) { setTumbling(false); fail(e); }
  }, [code, fail, say, R]);

  useEffect(() => {
    const v = virtualDice, g = goDice;
    const offs = [
      v.onRollStart(() => { tumbleSince.current = Date.now(); setTumbling(true); }),
      g.onRollStart(() => { tumbleSince.current = Date.now(); setTumbling(true); }),
      v.onRoll((i) => { if (diceMode === "virtual") void submitRoll(i); }),
      g.onRoll((i) => { if (diceMode === "godice") void submitRoll(i); }),
      g.onState((s) => { setGoState(s); if (s.kind === "cocked") { setTumbling(false); say(s.message); buzz([40, 30, 40]); } }),
    ];
    return () => offs.forEach((o) => o());
  }, [diceMode, submitRoll, say, virtualDice, goDice]);
  useEffect(() => () => { virtualDice.disconnect(); goDice.disconnect(); }, [virtualDice, goDice]);

  /* ── shown dice: land the latest roll with a tumble ── */
  const [shown, setShown] = useState({ d1: 1, d2: 1, id: 0 });
  const seenRoll = useRef<number | null>(null);
  const landTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rollId = lastRoll?.id, rollD1 = lastRoll?.d1, rollD2 = lastRoll?.d2;
  useEffect(() => {
    if (rollId == null || rollD1 == null || rollD2 == null) return;
    // first paint: show the current dice without animating (syncing to external server state)
    if (seenRoll.current === null) { seenRoll.current = rollId; setShown({ d1: rollD1, d2: rollD2, id: rollId }); return; }
    if (rollId === seenRoll.current) return;
    seenRoll.current = rollId;
    const rm = reducedMotion();
    // a new server roll arrived: start the tumble that the timeout below lands
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!rm) { setTumbling(true); if (!tumbleSince.current) tumbleSince.current = Date.now(); }
    const wait = rm ? 0 : Math.max(450, 700 - (Date.now() - tumbleSince.current));
    // not cleared by re-renders: a burst of realtime refetches must not cancel the landing
    if (landTimer.current) clearTimeout(landTimer.current);
    landTimer.current = setTimeout(() => {
      landTimer.current = null;
      setShown({ d1: rollD1, d2: rollD2, id: rollId }); setTumbling(false); tumbleSince.current = 0; buzz(25);
    }, wait);
  }, [rollId, rollD1, rollD2]);
  useEffect(() => () => { if (landTimer.current) clearTimeout(landTimer.current); }, []);
  // a local tumble that never got a roll back (network error, lost turn) must not freeze the button
  useEffect(() => {
    if (!tumbling) return;
    const t = setTimeout(() => { if (!landTimer.current) { setTumbling(false); tumbleSince.current = 0; } }, 4000);
    return () => clearTimeout(t);
  }, [tumbling]);
  const voided = lastRoll?.id === shown.id && lastRoll?.status === "void";

  /* ── event stream → animations ── */
  const [deltas, setDeltas] = useState<TileDelta[]>([]);
  const [flash, setFlash] = useState<{ text: string; cls: string } | null>(null);
  const [pop, setPop] = useState<{ net: number; key: number } | null>(null);
  const lastEvent = useRef<number | null>(null);
  useEffect(() => {
    if (!events.length) return;
    const top = events[0].id;
    if (lastEvent.current === null) { lastEvent.current = top; return; }
    const fresh = events.filter((e) => e.id > lastEvent.current!).reverse();
    lastEvent.current = Math.max(lastEvent.current, top);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const e of fresh) handle(e);
    function handle(e: EventRow) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are heterogeneous JSON
      const d = e.data as Record<string, any>;
      if (e.kind === "payout") {
        const key = e.id;
        setDeltas((x) => [...x.filter((y) => y.playerId !== e.actor_id), { playerId: e.actor_id!, net: Number(d.net), key }]);
        timers.push(setTimeout(() => setDeltas((x) => x.filter((y) => y.key !== key)), 1700));
        if (me && e.actor_id === me.id && Number(d.net) !== 0) {
          setPop({ net: Number(d.net), key });
          buzz(Number(d.net) > 0 ? [30, 50, 30, 50, 60] : 80);
          timers.push(setTimeout(() => setPop((p) => (p?.key === key ? null : p)), 1500));
        }
      } else if (e.kind === "roll_result") {
        const pointBefore = d.outcome === "point" ? null : (d.point as number | null) ?? null;
        const text = describeRoll(pointBefore, d.d1, d.d2);
        const cls = d.outcome === "win" ? "win" : d.outcome === "lose" ? "lose" : "";
        // let the dice land before the call
        timers.push(setTimeout(() => setFlash({ text, cls }), reducedMotion() ? 0 : 450));
        timers.push(setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 3200));
      } else if (e.kind === "catch_call") {
        buzz([50, 40, 50]);
      } else if (e.kind === "catch_upheld") {
        setFlash({ text: "Catch! Roll voided", cls: "lose" }); buzz([80, 40, 80]);
        timers.push(setTimeout(() => setFlash(null), 2600));
      } else if (e.kind === "catch_rejected") {
        setFlash({ text: "Catch rejected. Roll stands", cls: "" });
        timers.push(setTimeout(() => setFlash(null), 2200));
      }
    }
    return () => { /* timers intentionally run to completion */ };
  }, [events, me]);

  /* ── betting ── */
  const [side, setSide] = useState<Side>("against");
  const myBets = me ? bets.filter((b) => b.player_id === me.id && (b.status === "open" || b.status === "locked")) : [];
  const myStake = myBets.reduce((n, b) => n + Number(b.amount), 0);
  const sideThisHand = (myBets[0]?.side ?? null) as Side | null;
  const effSide: Side = isShooter ? "with" : sideThisHand ?? side;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); void R.refetch(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const bet = (amount: number) => act(async () => { buzz(10); await rpc("place_bet", { p_room: code, p_side: effSide, p_amount: amount }); });
  const betBlock = (amount: number) => room && me ? checkBet({
    phase: room.phase, seated: !!mySeat && mySeat.status === "active", isShooter, side: effSide, amount,
    balance: Number(me.balance), playedToday: Number(me.played_today), dailyCap: Number(me.daily_cap), sideThisHand,
  }) : "NOT_SEATED";

  /* ── catch ── */
  const callCatch = (reason: string) => act(async () => { buzz([30, 30, 30]); await rpc("call_catch", { p_room: code, p_reason: reason }); });
  const vote = (agree: boolean) => act(async () => { buzz(15); await rpc("vote_catch", { p_room: code, p_agree: agree }); });
  const myVote = me ? votes.find((v) => v.voter_id === me.id) : undefined;

  /* ── reactions over the tiles ── */
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const addFloat = useCallback((emoji: string) => {
    if (!EMOJIS.includes(emoji)) return;
    const id = Date.now() + Math.random();
    setFloaters((f) => [...f.slice(-14), { id, emoji, x: 6 + Math.random() * 82 }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 1900);
  }, []);
  const { send: sendData } = useDataChannel("react", (msg) => addFloat(new TextDecoder().decode(msg.payload)));
  const react = (emoji: string) => { addFloat(emoji); buzz(8); sendData(new TextEncoder().encode(emoji), { reliable: false }).catch(() => {}); };

  /* ── session timer + play limits ── */
  const [sessionStart] = useState(() => {
    try {
      const v = Number(sessionStorage.getItem("snakeyes-session-start"));
      if (v) return v;
      const now = Date.now(); sessionStorage.setItem("snakeyes-session-start", String(now)); return now;
    } catch { return Date.now(); }
  });
  const elapsed = Math.max(0, Math.floor((clientNow - sessionStart) / 1000));
  const nextRemind = useRef<number>(0);
  const warned80 = useRef(false);
  useEffect(() => {
    if (!nextRemind.current) nextRemind.current = Math.ceil((elapsed + 1) / remindSec) * remindSec;
    if (elapsed >= nextRemind.current && !limits && !watch) { nextRemind.current += remindSec; setLimits("time"); }
  }, [elapsed, remindSec, limits, watch]);
  useEffect(() => {
    if (!me || warned80.current) return;
    // server-reported play crossed 80% of the cap: open the reminder once
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (Number(me.played_today) >= 0.8 * Number(me.daily_cap)) { warned80.current = true; setLimits((l) => l ?? "cap80"); }
  }, [me]);

  /* ── sheets ── */
  const [sheet, setSheet] = useState<null | "chat" | "history" | "share" | "react" | "dice">(null);
  const [tab, setTab] = useState<"history" | "chat">("history");
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const cam = useTrackToggle({ source: Track.Source.Camera });

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const hasBots = seats.some((s) => s.is_bot);
  const freeSeats = RULES.maxSeats - seats.length;

  /* ── phase copy + clock ── */
  const now = clientNow + skew;
  const deadline = room?.phase_deadline ? new Date(room.phase_deadline).getTime() : null;
  const startedAt = room ? new Date(room.phase_started_at).getTime() : 0;
  const remaining = deadline ? Math.max(0, deadline - now) : 0;
  const frac = deadline && deadline > startedAt ? Math.min(1, remaining / (deadline - startedAt)) : 0;
  const secs = Math.ceil(remaining / 1000);
  const shooterName = shooter ? (shooter.player_id === me?.id ? "You" : shooter.player.username) : "—";
  const caller = openCatch ? seats.find((s) => s.player_id === openCatch.caller_id)?.player.username ?? "Someone" : "";
  const status = (() => {
    if (!room) return "Loading table…";
    switch (room.phase) {
      case "idle": return "Waiting for players";
      case "betting":
        return isShooter
          ? (diceMode === "godice" ? `Your roll: throw your GoDice (${secs}s)` : `Your roll. Tap or shake (${secs}s)`)
          : `${shooterName} ${room.point ? `needs a ${room.point}` : "is coming out"}. Bets open`;
      case "reroll": return isShooter ? `Roll voided. Reroll (${secs}s)` : `Roll voided. ${shooterName} rerolls`;
      case "catch_window": return `Dice are down. ${secs}s to call catch`;
      case "catch_vote": return `${caller} called CATCH (${secs}s)`;
    }
  })();

  const seatedActive = !!mySeat && mySeat.status === "active";
  const canVote = room?.phase === "catch_vote" && seatedActive && !isShooter && !myVote && openCatch;

  /* ── action area (fixed height; content swaps in place) ── */
  const actions = (() => {
    if (!room) return null;
    if (watch) return (
      <div style={{ textAlign: "center" }}>
        <div className="muted" style={{ marginBottom: 10 }}>You&apos;re watching. Spectators can chat and react but can&apos;t bet.</div>
        {freeSeats > 0 && <Link className="btn btn-acid" href={`/r/${code}`} data-testid="take-seat">Take a seat</Link>}
      </div>
    );
    if (!mySeat) return (
      <div style={{ textAlign: "center" }}>
        <div className="muted" style={{ marginBottom: 10 }}>Your seat was released.</div>
        <button className="btn btn-acid" onClick={() => act(() => rpc("join_room", { p_room: code }))}>Take a seat</button>
      </div>
    );
    if (room.phase === "catch_window" && !isShooter) return (
      <>
        <div className="catch-btn display" style={{ display: "grid", placeItems: "center" }} aria-hidden>CATCH!</div>
        <div className="reasons">
          <button onClick={() => callCatch("off_table")} disabled={busy} data-testid="catch-off_table">Off table</button>
          <button onClick={() => callCatch("cocked")} disabled={busy} data-testid="catch-cocked">Cocked</button>
          <button onClick={() => callCatch("bad_throw")} disabled={busy} data-testid="catch-bad_throw">Bad throw</button>
        </div>
      </>
    );
    if (room.phase === "catch_vote") {
      const yes = votes.filter((v) => v.agree).length, no = votes.length - yes, n = openCatch?.eligible ?? 0;
      return (
        <>
          <div className="tally" aria-label={`${yes} void, ${no} ride, of ${n}`}>
            {Array.from({ length: n }, (_, i) => <i key={i} className={i < yes ? "y" : i < yes + no ? "n" : ""} />)}
          </div>
          <div style={{ textAlign: "center", fontSize: 14 }} className="muted">
            {openCatch ? `Void needs ${Math.floor(n / 2) + 1} of ${n}. ${yes} so far.` : ""}
          </div>
          {canVote ? (
            <div className="vote">
              <button className="btn-pink" onClick={() => vote(true)} disabled={busy} data-testid="vote-yes">VOID IT</button>
              <button className="btn" onClick={() => vote(false)} disabled={busy} data-testid="vote-no">LET IT RIDE</button>
            </div>
          ) : (
            <div className="muted" style={{ textAlign: "center", height: 56, display: "grid", placeItems: "center" }}>
              {isShooter ? "The table is voting on your roll." : myVote ? `You voted ${myVote.agree ? "VOID" : "let it ride"}.` : "Voting…"}
            </div>
          )}
        </>
      );
    }
    if (room.phase === "catch_window" && isShooter) return <div className="muted" style={{ textAlign: "center" }}>Hands off the dice. Catch window open.</div>;
    const canRoll = isShooter && (room.phase === "betting" || room.phase === "reroll");
    const chipsRow = room.phase === "betting" && (
      <div className="chips">
        {[25, 50, 100, 250].map((a, i) => (
          <button key={a} className="coin tnum" style={{ ["--c" as string]: ["#38e1ff", "#ff3d7f", "#d7ff3b", "#ffb02e"][i] }}
            onClick={() => bet(a)} disabled={busy || !!betBlock(a)} aria-label={`Bet ${a}`} data-testid={`chip-${a}`}>{a}</button>
        ))}
        <button className="icon-btn" style={{ width: 48, height: 52 }} aria-label="Clear my open bets" disabled={busy || myBets.every((b) => b.status !== "open")}
          onClick={() => act(() => rpc("clear_bets", { p_room: code }))}>✕</button>
      </div>
    );
    if (canRoll) return (
      <>
        <div className="stake-line">
          <span className="muted">Back yourself</span>
          <b className="tnum" data-testid="my-stake">{myStake ? `Back ${myStake}${myBets.some((b) => b.status === "locked") ? " 🔒" : ""}` : "—"}</b>
        </div>
        {chipsRow || <div style={{ height: 52, display: "grid", placeItems: "center" }} className="muted">Stakes are locked for the reroll.</div>}
        {diceMode === "godice" && goState.kind !== "unsupported" ? (
          <button className="roll-btn" style={{ fontSize: 22 }} onClick={() => setSheet("dice")} data-testid="godice-roll">
            {goDice.connectedCount() >= 2 ? "🎲 Throw your dice" : "Connect GoDice"}
          </button>
        ) : (
          <button className="roll-btn" disabled={busy || tumbling} onClick={() => virtualDice.trigger()} data-testid="roll">
            🎲 ROLL{shake ? <span style={{ fontSize: 14, fontFamily: "var(--body)", fontWeight: 700 }}>or shake</span> : null}
          </button>
        )}
      </>
    );
    return (
      <>
        <div className="side-toggle" role="group" aria-label="Bet side">
          <button className="against" aria-pressed={effSide === "against"} disabled={!!sideThisHand && sideThisHand !== "against"} onClick={() => setSide("against")} data-testid="side-against">FADE THE SHOOTER</button>
          <button className="with" aria-pressed={effSide === "with"} disabled={!!sideThisHand && sideThisHand !== "with"} onClick={() => setSide("with")} data-testid="side-with">BACK THE SHOOTER</button>
        </div>
        {chipsRow || <div style={{ height: 52, display: "grid", placeItems: "center" }} className="muted">{room.phase === "reroll" ? "Stakes locked for the reroll." : "Waiting for the next roll."}</div>}
        <div className="stake-line">
          <span className="muted">Your stake</span>
          <b className="tnum" data-testid="my-stake">{myStake ? `${effSide === "against" ? "Fade" : "Back"} ${myStake}${myBets.some((b) => b.status === "locked") ? " 🔒" : ""}` : "—"}</b>
        </div>
      </>
    );
  })();

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0"), ss = String(elapsed % 60).padStart(2, "0");
  const actionsKey = !room ? "none" : watch ? "watch" : !mySeat ? "unseated"
    : room.phase === "catch_window" ? (isShooter ? "cw-shooter" : "cw")
    : room.phase === "catch_vote" ? `vote-${canVote ? "open" : "done"}`
    : isShooter && (room.phase === "betting" || room.phase === "reroll") ? `roll-${room.phase}` : `bet-${room.phase}`;

  return (
    <main className="shell">
      {toast && <div className="toast" role="status" data-testid="toast">{toast}</div>}
      {pop && <div key={pop.key} className={`payout-pop${pop.net < 0 ? " down" : ""}`} aria-hidden>{pop.net > 0 ? "+" : "−"}{Math.abs(pop.net)}</div>}

      <div className="room">
        <section className="room-main">
          <header className="topbar">
            <Link href="/" aria-label="SNAKEYES home" style={{ display: "contents" }}><Logo compact /></Link>
            <span className="chip tnum" data-testid="room-code" style={{ letterSpacing: ".12em" }}>{code}</span>
            <span className="grow" />
            <button className="timer tnum" onClick={() => setLimits("manual")} aria-label={`Session time ${mm}:${ss}. Play limits`} data-testid="session-timer">⏱ {mm}:{ss}</button>
            <span className="balance tnum" data-testid="my-balance">🪙 {me ? Number(me.balance).toLocaleString() : "—"}</span>
          </header>

          <VideoGrid seats={seats} bets={bets} shooterSeat={room?.shooter_seat ?? null} myId={me?.id ?? null} deltas={deltas} now={now}>
            <ReactionLayer items={floaters} />
          </VideoGrid>

          <div className="felt" data-testid="felt" data-phase={room?.phase ?? ""}>
            <div className="felt-top">
              <span className="chip" style={{ background: "rgba(0,0,0,.35)", borderColor: "transparent" }}>Hand #{room?.hand_no ?? 0}</span>
            </div>
            <div className={`puck${room?.point ? " on" : ""}`} aria-label={room?.point ? `Point is ${room.point}` : "Come-out roll"} data-testid="puck">
              {room?.point ? <span>ON<b>{room.point}</b></span> : "OFF"}
            </div>
            <Dice3D d1={shown.d1} d2={shown.d2} tumbling={tumbling} voided={voided} rollId={shown.id} />
            <div className={`status${flash ? ` big ${flash.cls}` : ""}`} data-testid="status" aria-live="polite">{flash?.text ?? status}</div>
            {deadline && <div className={`clock${room?.phase?.startsWith("catch") ? " pink" : ""}`}><i style={{ transform: `scaleX(${frac})` }} /></div>}
          </div>

          {/* keyed by variant: swapping layouts mounts fresh nodes instead of sliding old ones (no layout shift) */}
          <div className="actions" data-testid="actions" key={actionsKey}>{actions}</div>

          <nav className="toolbar" aria-label="Table controls">
            <div className="left">
              {!watch && <button className="icon-btn" aria-label={mic.enabled ? "Mute mic" : "Unmute mic"} aria-pressed={mic.enabled} onClick={() => mic.toggle()} data-testid="toggle-mic">{mic.enabled ? "🎙️" : "🔇"}</button>}
              {!watch && <button className="icon-btn" aria-label={cam.enabled ? "Turn camera off" : "Turn camera on"} aria-pressed={cam.enabled} onClick={() => cam.toggle()} data-testid="toggle-cam">{cam.enabled ? "📷" : "🚫"}</button>}
              <button className="icon-btn mobile-only" aria-label="Chat" onClick={() => setSheet("chat")} data-testid="open-chat">💬</button>
              <button className="icon-btn" aria-label="React" onClick={() => setSheet("react")} data-testid="open-react">😂</button>
            </div>
            <div className="right">
              {!watch && <button className="icon-btn" aria-label="Dice settings" onClick={() => setSheet("dice")} data-testid="open-dice">🎲</button>}
              <button className="icon-btn mobile-only" aria-label="Hand history" onClick={() => setSheet("history")} data-testid="open-history">📜</button>
              <button className="icon-btn mobile-only" aria-label="Share table" onClick={() => setSheet("share")} data-testid="open-share">📲</button>
              <button className="icon-btn" aria-label="Leave table" onClick={async () => { if (!watch) await rpc("leave_room", { p_room: code }).catch(() => {}); router.push("/"); }} data-testid="leave">🚪</button>
            </div>
          </nav>
        </section>

        <aside className="room-side" aria-label="Table info">
          <div className="card" style={{ padding: 12 }}>
            <SharePanel code={code} origin={origin} />
            {!watch && mySeat && (
              <button className="btn" style={{ width: "100%", marginTop: 8 }} data-testid="bots-toggle" disabled={busy || (!hasBots && freeSeats === 0)}
                onClick={() => act(() => rpc(hasBots ? "remove_bots" : "fill_bots", hasBots ? { p_room: code } : { p_room: code, p_count: 3 }))}>
                {hasBots ? "Remove bots" : "🤖 Fill with bots"}
              </button>
            )}
          </div>
          <div className="card panel" style={{ padding: 12, gap: 10 }}>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>Hand history</button>
              <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
            </div>
            {tab === "history" ? <HistoryPanel events={events} /> : <ChatPanel />}
          </div>
          <div className="emoji-bar">{EMOJIS.map((e) => <button key={e} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}</div>
        </aside>
      </div>

      {sheet === "chat" && <Sheet title="Table chat" onClose={() => setSheet(null)}><ChatPanel /></Sheet>}
      {sheet === "history" && <Sheet title="Hand history" onClose={() => setSheet(null)} testid="history-sheet"><HistoryPanel events={events} /></Sheet>}
      {sheet === "react" && (
        <Sheet title="React" onClose={() => setSheet(null)}>
          <div className="emoji-bar">{EMOJIS.map((e) => <button key={e} onClick={() => { react(e); setSheet(null); }} aria-label={`React ${e}`}>{e}</button>)}</div>
        </Sheet>
      )}
      {sheet === "share" && (
        <Sheet title="Bring friends" onClose={() => setSheet(null)} testid="share-sheet">
          <SharePanel code={code} origin={origin} />
          {!watch && mySeat && (
            <button className="btn" style={{ marginTop: 10 }} disabled={busy || (!hasBots && freeSeats === 0)} data-testid="bots-toggle-mobile"
              onClick={() => act(() => rpc(hasBots ? "remove_bots" : "fill_bots", hasBots ? { p_room: code } : { p_room: code, p_count: 3 }))}>
              {hasBots ? "Remove bots" : "🤖 Fill with bots"}
            </button>
          )}
        </Sheet>
      )}
      {sheet === "dice" && (
        <Sheet title="Dice" onClose={() => setSheet(null)} testid="dice-sheet">
          <div className="seg" style={{ marginBottom: 14 }}>
            <button aria-pressed={diceMode === "virtual"} onClick={() => setDiceMode("virtual")}>Virtual dice</button>
            <button aria-pressed={diceMode === "godice"} onClick={() => setDiceMode("godice")} data-testid="mode-godice">GoDice</button>
          </div>
          {diceMode === "virtual" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                Tap ROLL, or turn on shake-to-roll. Your phone only says &quot;roll&quot;. The server picks both faces, so nobody can rig a virtual roll.
              </p>
              <button className="btn" onClick={async () => { if (shake) { virtualDice.disableShake(); setShake(false); } else { const ok = await virtualDice.enableShake(); setShake(ok); if (!ok) say("Motion sensors aren't available on this device."); } }}>
                {shake ? "Turn off shake-to-roll" : "📳 Turn on shake-to-roll"}
              </button>
            </div>
          ) : (
            <GoDicePanel state={goState} supported={goDice.isSupported()} reason={goDice.unsupportedReason()}
              count={goState.kind === "connected" ? goState.dice.length : goDice.connectedCount()}
              onConnect={() => void goDice.connect()} onDisconnect={() => goDice.disconnect()}
              onUseVirtual={() => setDiceMode("virtual")} />
          )}
        </Sheet>
      )}
      {limits && me && (
        <Sheet title={limits === "cap" ? "Daily limit reached" : "Play limits"} onClose={() => setLimits(null)} testid="limits-sheet">
          <LimitsPanel minutes={Math.floor(elapsed / 60)} played={Number(me.played_today)} cap={Number(me.daily_cap)} reason={limits}
            onCap={(n) => act(() => rpc("set_daily_cap", { p_cap: n }))}
            onBreak={async () => { if (!watch) await rpc("leave_room", { p_room: code }).catch(() => {}); router.push("/"); }}
            onClose={() => setLimits(null)} />
        </Sheet>
      )}
    </main>
  );
}
