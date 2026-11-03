"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { useChat } from "@livekit/components-react";
import type { EventRow } from "@/lib/useRoom";
import type { DiceState } from "@/lib/dice/adapter";

/* ───────────── hand history ───────────── */

const REASON: Record<string, string> = { off_table: "dice off the table", cocked: "cocked dice", bad_throw: "bad throw", other: "foul" };
function fmt(e: EventRow): { text: string; cls?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are heterogeneous JSON
  const d = e.data as Record<string, any>;
  const who = e.actor_name ?? "Table";
  switch (e.kind) {
    case "room_created": return { text: `${who} opened the table` };
    case "join": return { text: `${who} sat down${d.bot ? " (bot)" : ""}` };
    case "leave": return { text: `${who} left` };
    case "new_hand": return { text: `${who} has the dice` };
    case "bet": return { text: `${who} ${d.side === "against" ? "fades" : "backs"} for ${d.amount}` };
    case "refund": return { text: `${who} refunded ${d.amount}` };
    case "roll": return { text: `${who} rolled ${d.d1}·${d.d2} = ${d.total}${d.source === "godice" ? " (GoDice)" : d.source === "auto" ? " (shot clock)" : ""}`, cls: "ev-roll" };
    case "roll_result":
      if (d.outcome === "point") return null;
      if (d.outcome === "continue") return { text: `${d.total}, no decision` };
      return null;
    case "point_set": return { text: `Point is ${d.point}` };
    case "hand_end": return { text: d.result === "win" ? `${who} wins the hand` : `${who} loses the hand`, cls: d.result === "win" ? "ev-win" : "ev-lose" };
    case "payout": return { text: `${who} ${d.net > 0 ? "+" : d.net < 0 ? "−" : "±"}${Math.abs(d.net)} (staked ${d.staked}, paid ${d.paid})`, cls: d.net > 0 ? "ev-win" : d.net < 0 ? "ev-lose" : undefined };
    case "catch_call": return { text: `${who} called CATCH: ${REASON[d.reason] ?? d.reason}`, cls: "ev-catch" };
    case "catch_vote": return { text: `${who} voted ${d.agree ? "VOID" : "let it ride"}`, cls: "ev-catch" };
    case "catch_upheld": return { text: `Catch upheld ${d.agree}/${d.eligible}. Roll voided, reroll`, cls: "ev-catch" };
    case "catch_rejected": return { text: `Catch rejected ${d.agree}/${d.eligible}. Roll stands`, cls: "ev-catch" };
    case "disconnect": return { text: `${who} disconnected (seat held 30s)` };
    case "reconnect": return { text: `${who} reconnected` };
    case "seat_released": return { text: `${who}'s seat was released` };
    case "skip": return { text: `Shooter gone, turn skipped` };
    case "hand_void": return { text: `Shooter gone, hand voided and bets refunded` };
    default: return null;
  }
}

export function HistoryPanel({ events }: { events: EventRow[] }) {
  // chronological, newest at the bottom: appending never moves what's already on screen
  const rows = useMemo(() => {
    const out: ({ hand: number } | { e: EventRow; f: { text: string; cls?: string } })[] = [];
    let lastHand: number | null = null;
    for (const e of [...events].reverse()) {
      const f = fmt(e);
      if (!f) continue;
      if (e.hand_no !== lastHand && e.hand_no) { out.push({ hand: e.hand_no }); lastHand = e.hand_no; }
      out.push({ e, f });
    }
    return out;
  }, [events]);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);
  return (
    <ol ref={list} className="history" data-testid="history" aria-label="Hand history" aria-live="off"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {rows.length === 0 && <li className="muted" style={{ display: "block" }}>No action yet.</li>}
      {rows.map((r, i) =>
        "hand" in r ? <li key={`h${r.hand}-${i}`} className="hand">Hand #{r.hand}</li> : (
          <li key={r.e.id} data-kind={r.e.kind}>
            <time dateTime={r.e.created_at}>{new Date(r.e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
            <span className={r.f.cls}>{r.f.text}</span>
          </li>
        ))}
    </ol>
  );
}

/* ───────────── chat (LiveKit data channel) ───────────── */

export function ChatPanel({ onUnread }: { onUnread?: (n: number) => void }) {
  const { chatMessages, send, isSending } = useChat();
  const [text, setText] = useState("");
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); onUnread?.(chatMessages.length); }, [chatMessages.length, onUnread]);
  return (
    <div className="chat">
      <ol ref={list} data-testid="chat-list">
        {chatMessages.length === 0 && <li className="muted">Say something to the table.</li>}
        {chatMessages.map((m) => (
          <li key={m.id ?? `${m.timestamp}-${m.from?.identity}`}><b>{m.from?.name ?? "someone"}</b>{m.message}</li>
        ))}
      </ol>
      <form onSubmit={async (e) => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(""); await send(t); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={240} placeholder="Message the table" aria-label="Chat message" />
        <button className="btn btn-acid" disabled={isSending || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

/* ───────────── share: QR codes ───────────── */

function Qr({ url, title, sub, testid }: { url: string; title: string; sub: string; testid: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 300, color: { dark: "#0d0f02", light: "#ffffff" } }).then(setSrc).catch(() => setSrc(null));
  }, [url]);
  return (
    <div className="qr" data-testid={testid}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={`QR code for ${title}`} width={150} height={150} /> : <div style={{ width: "100%", aspectRatio: 1 }} />}
      <b>{title}</b>
      <span>{sub}</span>
      <button className="btn" style={{ height: 34, fontSize: 13, width: "100%" }}
        onClick={() => navigator.clipboard?.writeText(url).catch(() => {})}>Copy link</button>
    </div>
  );
}

export function SharePanel({ code, origin }: { code: string; origin: string }) {
  const room = `${origin}/r/${code}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="qr-grid">
        <Qr url={room} title="Join this table" sub={`/r/${code}`} testid="qr-room" />
        <Qr url={`${room}?bots=1`} title="Open with bots" sub={`/r/${code}?bots=1`} testid="qr-bots" />
      </div>
      <button className="btn" onClick={() => navigator.clipboard?.writeText(`${room}?watch=1`).catch(() => {})}>
        👀 Copy spectator link
      </button>
    </div>
  );
}

/* ───────────── reactions ───────────── */

export const EMOJIS = ["🔥", "😂", "😱", "💸", "🎲", "👀"];
export interface Floater { id: number; emoji: string; x: number }
export function ReactionLayer({ items }: { items: Floater[] }) {
  return (
    <div className="reactions" aria-hidden>
      {items.map((f) => <span key={f.id} className="float-emoji" style={{ left: `${f.x}%` }}>{f.emoji}</span>)}
    </div>
  );
}

/* ───────────── GoDice connect ───────────── */

export function GoDicePanel({ state, supported, reason, count, onConnect, onDisconnect, onUseVirtual }: {
  state: DiceState; supported: boolean; reason: string; count: number;
  onConnect: () => void; onDisconnect: () => void; onUseVirtual: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Roll real GoDice smart dice on camera. Each die reports its face over Bluetooth the moment it settles. A tilted
        (cocked) die or a die placed by hand is rejected before it reaches the table.
      </p>
      {!supported ? (
        <div className="card" style={{ padding: 12, borderColor: "#5a1631" }} role="note">
          <b>Bluetooth isn&apos;t available here.</b>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{reason}</div>
        </div>
      ) : (
        <>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7 }}>
            <li>Wake both dice (give them a shake).</li>
            <li>Tap <b>Connect die {Math.min(count + 1, 2)}</b> and pick a <code>GoDice_…</code> device.</li>
            <li>Repeat for the second die, then throw both on camera.</li>
          </ol>
          <div className="chip" style={{ alignSelf: "flex-start" }} data-testid="godice-state">
            {state.kind === "connected" ? `${state.dice.length}/2 dice connected${state.dice.some((d) => d.battery) ? ` · 🔋 ${state.dice.map((d) => d.battery ?? "?").join("% / ")}%` : ""}`
              : state.kind === "connecting" ? "Opening Bluetooth…"
              : state.kind === "rolling" ? "Rolling…"
              : state.kind === "cocked" ? state.message
              : state.kind === "error" ? `Error: ${state.message}`
              : "No dice connected"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-acid" style={{ flex: 1 }} onClick={onConnect} disabled={count >= 2 || state.kind === "connecting"}>
              {count >= 2 ? "Both dice ready" : `Connect die ${count + 1}`}
            </button>
            {count > 0 && <button className="btn" onClick={onDisconnect}>Disconnect</button>}
          </div>
        </>
      )}
      <button className="btn btn-ghost" onClick={onUseVirtual}>Use virtual dice instead</button>
    </div>
  );
}

/* ───────────── play limits ───────────── */

export function LimitsPanel({ minutes, played, cap, reason, onCap, onBreak, onClose }: {
  minutes: number; played: number; cap: number; reason: "time" | "cap80" | "cap" | "manual";
  onCap: (n: number) => void; onBreak: () => void; onClose: () => void;
}) {
  const pct = Math.min(100, Math.round((played / cap) * 100));
  const opts = [500, 1000, 2500, 5000, 10000];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="limits">
      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.45 }}>
        {reason === "cap" ? "You've hit today's coin-play limit. It resets at midnight Central."
          : reason === "cap80" ? `Heads up: you've played ${pct}% of today's limit.`
          : reason === "time" ? `You've been at the table ${minutes} minutes. Good time to stretch?`
          : "Your play limits for today."}
      </p>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }} className="muted">
          <span>Played today</span><span className="tnum">{played.toLocaleString()} / {cap.toLocaleString()}</span>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: "#222", marginTop: 6, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: pct >= 80 ? "var(--pink)" : "var(--acid)" }} />
        </div>
      </div>
      <div className="field">
        <label>Daily coin-play limit</label>
        <div className="seg">
          {opts.map((o) => (
            <button key={o} aria-pressed={cap === o} onClick={() => onCap(o)}>{o >= 1000 ? `${o / 1000}k` : o}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={onBreak}>Take a break</button>
        <button className="btn btn-acid" style={{ flex: 1 }} onClick={onClose}>{reason === "cap" ? "OK" : "Keep playing"}</button>
      </div>
    </div>
  );
}

/* ───────────── generic sheet ───────────── */

export function Sheet({ title, onClose, children, testid }: { title: string; onClose: () => void; children: React.ReactNode; testid?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} data-testid={testid}>
        <div className="sheet-handle" />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      </div>
    </>
  );
}
