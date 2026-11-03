import { Emitter, type DiceAdapter, type DiceState, type RollIntent } from "./adapter";

/** Tap or shake to roll. The client only signals intent; Postgres generates both faces. */
export class VirtualDice implements DiceAdapter {
  readonly kind = "virtual" as const;
  readonly label = "Virtual dice";
  private rolls = new Emitter<RollIntent>();
  private starts = new Emitter<void>();
  private states = new Emitter<DiceState>();
  private shakeOff: (() => void) | null = null;

  isSupported() { return true; }
  async connect() {}
  disconnect() { this.disableShake(); }
  state(): DiceState { return { kind: "ready" }; }
  onRoll(cb: (i: RollIntent) => void) { return this.rolls.on(cb); }
  onRollStart(cb: () => void) { return this.starts.on(cb); }
  onState(cb: (s: DiceState) => void) { return this.states.on(cb); }

  /** tap-to-roll */
  trigger() { this.starts.emit(); this.rolls.emit({ source: "virtual" }); }

  /** iOS needs a permission prompt from a user gesture before devicemotion fires. */
  async enableShake(): Promise<boolean> {
    if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return false;
    const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<"granted" | "denied"> };
    if (typeof DME.requestPermission === "function") {
      try { if ((await DME.requestPermission()) !== "granted") return false; } catch { return false; }
    }
    this.disableShake();
    let last = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a) return;
      const g = Math.sqrt((a.x ?? 0) ** 2 + (a.y ?? 0) ** 2 + (a.z ?? 0) ** 2);
      const now = Date.now();
      if (g > 24 && now - last > 1500) { last = now; this.trigger(); }
    };
    window.addEventListener("devicemotion", onMotion);
    this.shakeOff = () => window.removeEventListener("devicemotion", onMotion);
    return true;
  }
  disableShake() { this.shakeOff?.(); this.shakeOff = null; }
}
