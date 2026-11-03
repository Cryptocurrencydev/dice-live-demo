/**
 * One interface for every way a roll can enter the game.
 *
 *   VirtualDice  — tap / shake. Emits { source: "virtual" }; the SERVER picks the faces.
 *   GoDiceWeb    — GoDice over Web Bluetooth (Chrome on Android / desktop). Emits the faces the dice report.
 *   (native)     — the React Native app swaps in an adapter over the GoDice iOS/Android SDKs with the
 *                  same shape; nothing above this file changes. See README "Dice adapters".
 */
export type RollIntent = { source: "virtual" } | { source: "godice"; d1: number; d2: number };

export type DiceState =
  | { kind: "ready" }
  | { kind: "unsupported"; reason: string }
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; dice: { id: string; battery?: number }[] }
  | { kind: "rolling" }
  | { kind: "cocked"; message: string }
  | { kind: "error"; message: string };

export interface DiceAdapter {
  readonly kind: "virtual" | "godice";
  readonly label: string;
  isSupported(): boolean;
  /** Pair hardware (no-op for virtual). Must be called from a user gesture for Web Bluetooth. */
  connect(): Promise<void>;
  disconnect(): void;
  state(): DiceState;
  /** A finished roll the player wants to submit. */
  onRoll(cb: (intent: RollIntent) => void): () => void;
  /** Dice started tumbling (drives the animation before the result lands). */
  onRollStart(cb: () => void): () => void;
  onState(cb: (s: DiceState) => void): () => void;
}

export class Emitter<T> {
  private subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  emit(v: T) { for (const s of this.subs) s(v); }
}
