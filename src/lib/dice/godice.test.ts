import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollIntent } from "./adapter";
import { GoDiceWeb, ROLL_SETTLE_MS, type GoDiceCtor, type GoDiceInstance } from "./godice";
import { VirtualDice } from "./virtual";

/**
 * A stand-in for Particula's `GoDice` class with the same documented surface:
 * requestDevice() connects one die and fires onDiceConnected; the test then drives
 * onRollStart / onStable / onTiltStable / onFakeStable exactly as the SDK would.
 */
function mockSdk() {
  const created: (GoDiceInstance & { id: string })[] = [];
  let n = 0;
  class FakeGoDice implements GoDiceInstance {
    id = `GoDice_${++n}`;
    onDiceConnected?: GoDiceInstance["onDiceConnected"];
    onRollStart?: GoDiceInstance["onRollStart"];
    onStable?: GoDiceInstance["onStable"];
    onTiltStable?: GoDiceInstance["onTiltStable"];
    onFakeStable?: GoDiceInstance["onFakeStable"];
    onBatteryLevel?: GoDiceInstance["onBatteryLevel"];
    onDiceDisconnected?: GoDiceInstance["onDiceDisconnected"];
    getBatteryLevel = vi.fn(() => setTimeout(() => this.onBatteryLevel?.(this.id, 87)));
    pulseLed = vi.fn();
    bluetoothDevice = { gatt: { connected: true, disconnect: vi.fn() } };
    async requestDevice() {
      created.push(this);
      this.onDiceConnected?.(this.id, this);
    }
  }
  return { Ctor: FakeGoDice as unknown as GoDiceCtor, created };
}

async function pairTwo() {
  const sdk = mockSdk();
  const adapter = new GoDiceWeb({ loadSdk: async () => sdk.Ctor, bluetoothAvailable: () => true });
  await adapter.connect();
  await adapter.connect();
  const [a, b] = sdk.created;
  return { adapter, a, b, sdk };
}

describe("GoDiceWeb adapter (mocked SDK)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports unsupported when Web Bluetooth is missing (iOS Safari)", async () => {
    const adapter = new GoDiceWeb({ loadSdk: async () => mockSdk().Ctor, bluetoothAvailable: () => false });
    await adapter.connect();
    expect(adapter.state().kind).toBe("unsupported");
  });

  it("pairs one die per requestDevice, pulses its LEDs and reads battery", async () => {
    const { adapter, a } = await pairTwo();
    expect(adapter.connectedCount()).toBe(2);
    expect(a.pulseLed).toHaveBeenCalled();
    await vi.runAllTimersAsync();
    const s = adapter.state();
    expect(s.kind === "connected" && s.dice.map((d) => d.battery)).toEqual([87, 87]);
  });

  it("emits one roll when both dice tumble and settle flat", async () => {
    const { adapter, a, b } = await pairTwo();
    const rolls: RollIntent[] = []; const starts = vi.fn();
    adapter.onRoll((r) => rolls.push(r)); adapter.onRollStart(starts);
    a.onRollStart!(a.id); b.onRollStart!(b.id);
    expect(adapter.state().kind).toBe("rolling");
    a.onStable!(a.id, 3, [0, 0, 64]);
    expect(rolls).toHaveLength(0);
    b.onStable!(b.id, 4, [0, 0, 64]);
    expect(rolls).toEqual([{ source: "godice", d1: 3, d2: 4 }]);
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it("ignores settling that wasn't part of a throw", async () => {
    const { adapter, a, b } = await pairTwo();
    const rolls: RollIntent[] = []; adapter.onRoll((r) => rolls.push(r));
    a.onStable!(a.id, 6, []); b.onStable!(b.id, 6, []);
    expect(rolls).toHaveLength(0);
  });

  it("a tilted (cocked) die cancels the throw", async () => {
    const { adapter, a, b } = await pairTwo();
    const rolls: RollIntent[] = []; adapter.onRoll((r) => rolls.push(r));
    a.onRollStart!(a.id); b.onRollStart!(b.id);
    a.onStable!(a.id, 2, []);
    b.onTiltStable!(b.id, [10, 40, 20], 5);
    expect(adapter.state()).toMatchObject({ kind: "cocked" });
    b.onStable!(b.id, 5, []);
    expect(rolls).toHaveLength(0);
  });

  it("a hand-placed die (fake stable) cancels the throw", async () => {
    const { adapter, a } = await pairTwo();
    a.onRollStart!(a.id);
    a.onFakeStable!(a.id, 6, []);
    expect(adapter.state()).toMatchObject({ kind: "cocked" });
  });

  it("times out when only one die lands", async () => {
    const { adapter, a } = await pairTwo();
    a.onRollStart!(a.id); a.onStable!(a.id, 1, []);
    vi.advanceTimersByTime(ROLL_SETTLE_MS + 1);
    expect(adapter.state()).toMatchObject({ kind: "cocked", message: expect.stringMatching(/Only one die/) });
  });

  it("a user closing the Bluetooth picker is not an error", async () => {
    class Cancelled { async requestDevice() { throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError"); } }
    const adapter = new GoDiceWeb({ loadSdk: async () => Cancelled as unknown as GoDiceCtor, bluetoothAvailable: () => true });
    await adapter.connect();
    expect(adapter.state().kind).toBe("disconnected");
  });

  it("disconnect closes GATT on every die", async () => {
    const { adapter, a, b } = await pairTwo();
    adapter.disconnect();
    expect(a.bluetoothDevice!.gatt!.disconnect).toHaveBeenCalled();
    expect(b.bluetoothDevice!.gatt!.disconnect).toHaveBeenCalled();
    expect(adapter.state().kind).toBe("disconnected");
  });
});

describe("VirtualDice", () => {
  it("only signals intent — never faces", () => {
    const v = new VirtualDice(); const rolls: RollIntent[] = [];
    v.onRoll((r) => rolls.push(r)); v.trigger();
    expect(rolls).toEqual([{ source: "virtual" }]);
  });
});
