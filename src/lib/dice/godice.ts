import { Emitter, type DiceAdapter, type DiceState, type RollIntent } from "./adapter";

/**
 * GoDice over Web Bluetooth, written against Particula's documented JavaScript API
 * (github.com/ParticulaCode/GoDiceJavaScriptAPI):
 *
 *   const die = new GoDice();          // one instance per physical die
 *   die.onDiceConnected = (diceId, instance) => …
 *   die.onRollStart     = (diceId) => …
 *   die.onStable        = (diceId, value, xyz) => …   // die came to rest flat: value 1–6
 *   die.onTiltStable    = (diceId, xyz, value) => …   // came to rest tilted  → "cocked dice"
 *   die.onFakeStable    = (diceId, value, xyz) => …   // stopped but was moved by hand, not rolled
 *   die.onMoveStable    = (diceId, value, xyz) => …
 *   die.onBatteryLevel  = (diceId, level) => …
 *   die.onDiceDisconnected = (diceId, instance) => …
 *   await die.requestDevice();          // opens Chrome's Bluetooth picker (needs a user gesture)
 *
 * Particula's license forbids redistributing godice.js, so it is NOT bundled: it is loaded at runtime
 * from their public repo only when a player taps "Connect dice". Commercial use needs Particula's
 * agreement (see README).
 *
 * The native apps use the GoDice iOS / Android SDKs, which expose the same events
 * (rollStarted / stable / tiltStable / fakeStable / battery), so a React Native adapter maps 1:1.
 */

export interface GoDiceInstance {
  requestDevice(): Promise<void>;
  getBatteryLevel?(): void;
  setLed?(a: number[] | null, b: number[] | null): void;
  pulseLed?(count: number, on: number, off: number, rgb: number[]): void;
  bluetoothDevice?: { gatt?: { connected: boolean; disconnect(): void } };
  onDiceConnected?: (diceId: string, inst: GoDiceInstance) => void;
  onDiceDisconnected?: (diceId: string, inst: GoDiceInstance) => void;
  onRollStart?: (diceId: string) => void;
  onStable?: (diceId: string, value: number, xyz: number[]) => void;
  onTiltStable?: (diceId: string, xyz: number[], value: number) => void;
  onFakeStable?: (diceId: string, value: number, xyz: number[]) => void;
  onMoveStable?: (diceId: string, value: number, xyz: number[]) => void;
  onBatteryLevel?: (diceId: string, level: number) => void;
}
export type GoDiceCtor = new () => GoDiceInstance;

export const GODICE_SDK_URL =
  process.env.NEXT_PUBLIC_GODICE_SDK_URL ?? "https://cdn.jsdelivr.net/gh/ParticulaCode/GoDiceJavaScriptAPI@main/godice.js";

let sdkPromise: Promise<GoDiceCtor> | null = null;
/** Load the official SDK (it declares a global `class GoDice`). */
export function loadGoDiceSdk(url = GODICE_SDK_URL): Promise<GoDiceCtor> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<GoDiceCtor>((resolve, reject) => {
    const existing = (globalThis as { GoDice?: GoDiceCtor }).GoDice;
    if (existing) return resolve(existing);
    // `class` declarations in classic scripts don't attach to window, so expose it explicitly.
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`GoDice SDK HTTP ${r.status}`))))
      .then((src) => {
        const s = document.createElement("script");
        s.text = `${src}\n;window.GoDice = GoDice;`;
        document.head.appendChild(s);
        const ctor = (globalThis as { GoDice?: GoDiceCtor }).GoDice;
        if (!ctor) throw new Error("GoDice SDK did not load");
        resolve(ctor);
      })
      .catch((e) => { sdkPromise = null; reject(e); });
  });
  return sdkPromise;
}

export const ROLL_SETTLE_MS = 4000;

export class GoDiceWeb implements DiceAdapter {
  readonly kind = "godice" as const;
  readonly label = "GoDice (Bluetooth)";
  private rolls = new Emitter<RollIntent>();
  private starts = new Emitter<void>();
  private states = new Emitter<DiceState>();
  private dice = new Map<string, { inst: GoDiceInstance; battery?: number }>();
  private order: string[] = [];
  private current: DiceState = { kind: "disconnected" };
  // roll assembly: a roll = both dice tumble, then both settle flat
  private rollingSince: number | null = null;
  private settled = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: {
      loadSdk?: () => Promise<GoDiceCtor>;
      bluetoothAvailable?: () => boolean;
      now?: () => number;
    } = {},
  ) {}

  isSupported() {
    if (this.opts.bluetoothAvailable) return this.opts.bluetoothAvailable();
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }
  unsupportedReason() {
    if (typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent))
      return "iOS Safari has no Web Bluetooth. The native iOS app uses the GoDice iOS SDK.";
    return "This browser has no Web Bluetooth. Use Chrome on Android or desktop.";
  }
  state() { return this.current; }
  onRoll(cb: (i: RollIntent) => void) { return this.rolls.on(cb); }
  onRollStart(cb: () => void) { return this.starts.on(cb); }
  onState(cb: (s: DiceState) => void) { return this.states.on(cb); }
  connectedCount() { return this.dice.size; }

  private set(s: DiceState) { this.current = s; this.states.emit(s); }
  private connectedState(): DiceState {
    return { kind: "connected", dice: this.order.map((id) => ({ id, battery: this.dice.get(id)?.battery })) };
  }

  /** Pair ONE die per call (that's how the SDK's requestDevice works). Call twice for two dice. */
  async connect() {
    if (!this.isSupported()) { this.set({ kind: "unsupported", reason: this.unsupportedReason() }); return; }
    this.set({ kind: "connecting" });
    try {
      const Ctor = await (this.opts.loadSdk ?? loadGoDiceSdk)();
      const die = new Ctor();
      die.onDiceConnected = (id, inst) => {
        if (!this.dice.has(id)) this.order.push(id);
        this.dice.set(id, { inst });
        inst.getBatteryLevel?.();
        inst.pulseLed?.(2, 20, 20, [215, 255, 59]);
        this.set(this.connectedState());
      };
      die.onDiceDisconnected = (id) => {
        this.dice.delete(id);
        this.order = this.order.filter((d) => d !== id);
        this.set(this.dice.size ? this.connectedState() : { kind: "disconnected" });
      };
      die.onBatteryLevel = (id, level) => {
        const d = this.dice.get(id);
        if (d) { d.battery = level; this.set(this.connectedState()); }
      };
      die.onRollStart = (id) => this.handleRollStart(id);
      die.onStable = (id, value) => this.handleStable(id, value);
      die.onTiltStable = (id) => this.handleCocked(id, "A die landed cocked (tilted). Pick them up and roll again.");
      die.onFakeStable = (id) => this.handleCocked(id, "A die was moved by hand, not rolled. Roll again.");
      await die.requestDevice();
      if (this.current.kind === "connecting") this.set(this.dice.size ? this.connectedState() : { kind: "disconnected" });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      // user closed the Bluetooth picker: not an error worth shouting about
      if (/cancel|User cancelled|NotFoundError/i.test(msg)) this.set(this.dice.size ? this.connectedState() : { kind: "disconnected" });
      else this.set({ kind: "error", message: msg });
    }
  }

  disconnect() {
    for (const { inst } of this.dice.values()) inst.bluetoothDevice?.gatt?.disconnect();
    this.dice.clear(); this.order = []; this.reset();
    this.set({ kind: "disconnected" });
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private reset() {
    this.rollingSince = null; this.settled.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** exposed for tests and for the SDK callbacks above */
  handleRollStart(id: string) {
    if (!this.dice.has(id)) return;
    if (this.rollingSince === null) {
      this.rollingSince = this.now();
      this.settled.clear();
      this.starts.emit();
      this.set({ kind: "rolling" });
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {   // one die never settled: not a valid throw
        this.reset();
        this.set({ kind: "cocked", message: "Only one die landed. Throw both dice together." });
      }, ROLL_SETTLE_MS);
    }
    this.settled.delete(id);
  }

  handleStable(id: string, value: number) {
    if (!this.dice.has(id) || this.rollingSince === null) return;   // ignore settling outside a throw
    if (!Number.isInteger(value) || value < 1 || value > 6) return;
    this.settled.set(id, value);
    if (this.order.length >= 2 && this.order.slice(0, 2).every((d) => this.settled.has(d))) {
      const [d1, d2] = this.order.slice(0, 2).map((d) => this.settled.get(d)!);
      this.reset();
      this.set(this.connectedState());
      this.rolls.emit({ source: "godice", d1, d2 });
    }
  }

  handleCocked(id: string, message: string) {
    if (!this.dice.has(id)) return;
    this.reset();
    this.set({ kind: "cocked", message });
  }
}
