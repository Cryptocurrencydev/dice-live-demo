"use client";
import { useMemo } from "react";
import { VideoTrack, useTracks, isTrackReference, type TrackReference } from "@livekit/components-react";
import { Track } from "livekit-client";
import type { BetRow, SeatRow } from "@/lib/useRoom";
import { RULES } from "@/lib/rules";

const AVATAR_COLORS = ["#d7ff3b", "#ff3d7f", "#38e1ff", "#ffb02e", "#a78bfa", "#46f28b", "#ff7a59", "#f4f1ea"];

export interface TileDelta { playerId: string; net: number; key: number }

export function VideoGrid({
  seats, bets, shooterSeat, myId, deltas, now, children,
}: {
  seats: SeatRow[]; bets: BetRow[]; shooterSeat: number | null; myId: string | null;
  deltas: TileDelta[]; now: number; children?: React.ReactNode;
}) {
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }], { onlySubscribed: false });
  const byIdentity = useMemo(() => {
    const m = new Map<string, TrackReference>();
    for (const t of tracks) if (isTrackReference(t) && !t.publication.isMuted) m.set(t.participant.identity, t);
    return m;
  }, [tracks]);

  const stakes = useMemo(() => {
    const m = new Map<string, { amount: number; side: "with" | "against" }>();
    for (const b of bets) {
      if (b.status !== "open" && b.status !== "locked") continue;
      const cur = m.get(b.player_id);
      m.set(b.player_id, { amount: (cur?.amount ?? 0) + Number(b.amount), side: b.side });
    }
    return m;
  }, [bets]);

  const slots = Array.from({ length: RULES.maxSeats }, (_, i) => seats.find((s) => s.seat_no === i) ?? null);

  return (
    <div className="grid" data-testid="video-grid">
      {slots.map((s, i) => {
        if (!s) return <div key={`empty-${i}`} className="tile empty" aria-label="Open seat">open</div>;
        const ref = byIdentity.get(s.player_id);
        const stake = stakes.get(s.player_id);
        const isShooter = s.seat_no === shooterSeat;
        const isMe = s.player_id === myId;
        const delta = deltas.find((d) => d.playerId === s.player_id);
        const holdLeft = s.status === "away" && s.hold_until
          ? Math.max(0, Math.ceil((new Date(s.hold_until).getTime() - now) / 1000)) : null;
        return (
          <div key={s.player_id} data-testid="tile" data-player={s.player.username} data-bot={s.is_bot ? "1" : "0"}
            data-status={s.status} data-shooter={isShooter ? "1" : "0"} data-has-video={ref ? "1" : "0"}
            className={`tile${isShooter ? " shooter" : ""}${isMe ? " self" : ""}${s.status === "away" ? " away" : ""}`}>
            {ref ? (
              <VideoTrack trackRef={ref} muted={isMe} playsInline />
            ) : (
              <div className="avatar" style={{ background: AVATAR_COLORS[(s.seat_no + (s.is_bot ? 3 : 0)) % 8] }} aria-hidden>
                {s.is_bot ? "🤖" : s.player.username.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="tag">
              <span style={{ display: "flex", gap: 3 }}>
                {isShooter && <span className="pill pill-acid">🎲 Shooter</span>}
                {s.is_bot && <span className="pill pill-dark">Bot</span>}
                {holdLeft !== null && <span className="pill pill-dark tnum">Away {holdLeft}s</span>}
              </span>
              {stake && (
                <span className={`pill ${stake.side === "against" ? "pill-pink" : "pill-cyan"} tnum`} data-testid="tile-bet">
                  {stake.side === "against" ? "Fade" : "Back"} {stake.amount}
                </span>
              )}
            </div>
            <div className="meta">
              <span className="name">{s.player.username}{isMe ? " (you)" : ""}</span>
              <span className="coins tnum" data-testid="tile-coins">🪙 {Number(s.player.balance).toLocaleString()}</span>
            </div>
            {delta && (
              <div key={delta.key} className={`delta ${delta.net >= 0 ? "up" : "down"}`}>
                {delta.net >= 0 ? "+" : "−"}{Math.abs(delta.net)}
              </div>
            )}
          </div>
        );
      })}
      {children}
    </div>
  );
}
