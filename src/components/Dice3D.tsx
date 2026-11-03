"use client";
import { useEffect, useRef, useState } from "react";

// pip positions on a 3×3 grid (1-indexed cells)
const PIPS: Record<number, number[]> = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
// cube layout: front 1, back 6, right 3, left 4, top 2, bottom 5 → rotation that brings face v to the front
const FACE_ROT: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
const FACE_TF: Record<number, string> = {
  1: "translateZ(var(--h))", 6: "rotateY(180deg) translateZ(var(--h))", 3: "rotateY(90deg) translateZ(var(--h))",
  4: "rotateY(-90deg) translateZ(var(--h))", 2: "rotateX(90deg) translateZ(var(--h))", 5: "rotateX(-90deg) translateZ(var(--h))",
};

function Face({ v }: { v: number }) {
  return (
    <div className={`face f${v}`} style={{ transform: FACE_TF[v] }}>
      {Array.from({ length: 9 }, (_, i) => (PIPS[v].includes(i + 1) ? <i key={i} /> : <span key={i} />))}
    </div>
  );
}

function Die({ value, tumbling, voided, seed }: { value: number; tumbling: boolean; voided: boolean; seed: number }) {
  // accumulate whole spins so every landing visibly rolls forward instead of snapping back
  const spins = useRef({ x: 0, y: 0 });
  const [tf, setTf] = useState(() => rot(value, 0, 0));
  useEffect(() => {
    if (tumbling) return;
    spins.current.x += 2 + ((seed * 7) % 2);
    spins.current.y += 2 + ((seed * 3) % 3);
    setTf(rot(value, spins.current.x, spins.current.y));
  }, [value, tumbling, seed]);
  return (
    <div className="die-wrap" style={{ ["--h" as string]: "calc(var(--s) / 2)" }}>
      <div className={`die${tumbling ? " tumble" : ""}${voided ? " voided" : ""}`} style={{ transform: tumbling ? undefined : tf }}>
        {[1, 2, 3, 4, 5, 6].map((v) => <Face key={v} v={v} />)}
      </div>
      <div className="die-shadow" />
    </div>
  );
}
function rot(v: number, sx: number, sy: number) {
  const [x, y] = FACE_ROT[v];
  return `rotateX(${x + sx * 360}deg) rotateY(${y + sy * 360}deg)`;
}

export function Dice3D({ d1, d2, tumbling, voided, rollId }: { d1: number; d2: number; tumbling: boolean; voided: boolean; rollId: number }) {
  return (
    <div className="dice-row" style={{ position: "relative" }} aria-live="polite" aria-label={tumbling ? "Dice rolling" : `Dice show ${d1} and ${d2}`}
      data-testid="dice" data-d1={d1} data-d2={d2} data-rolling={tumbling ? "1" : "0"}>
      <div style={{ ["--s" as string]: "var(--die)" }} className="die-size"><Die value={d1} tumbling={tumbling} voided={voided} seed={rollId} /></div>
      <div style={{ ["--s" as string]: "var(--die)" }} className="die-size"><Die value={d2} tumbling={tumbling} voided={voided} seed={rollId + 1} /></div>
      {voided && !tumbling && <div className="void-stamp">VOID</div>}
      <style>{`.dice-row{--die:64px}@media(min-width:1024px){.dice-row{--die:84px}}`}</style>
    </div>
  );
}
