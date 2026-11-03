"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo, LogoMark } from "@/components/Logo";
import { SignIn } from "@/components/SignIn";
import { ensureSession, myStatus, rpc, type Me } from "@/lib/supabase";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try { await ensureSession(); setMe(await myStatus()); } catch { setMe(null); }
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the session once on mount
  useEffect(() => { void load(); }, []);

  async function start(bots: boolean) {
    setBusy(bots ? "bots" : "table");
    try {
      const room = await rpc<string>("create_room");
      router.push(`/r/${room}${bots ? "?bots=1" : ""}`);
    } catch { setBusy(null); }
  }

  return (
    <main className="shell" style={{ maxWidth: 520, paddingTop: 22 }}>
      <Logo />
      <section style={{ marginTop: 34, position: "relative" }}>
        <LogoMark className="hero-mark" />
        <h1 className="display" style={{ fontSize: "clamp(52px, 17vw, 88px)", margin: 0 }}>
          Roll live.<br /><span style={{ color: "var(--acid)" }}>Talk trash.</span><br />Catch cheats.
        </h1>
        <p className="muted" style={{ fontSize: 17, lineHeight: 1.45, margin: "16px 0 26px", maxWidth: 420 }}>
          Street dice on live video with up to 8 players. Every roll, bet and catch call is refereed by the server.
          Free coins only.
        </p>
      </section>

      <div className="card" style={{ padding: 18, minHeight: 236 }}>
        {me === undefined ? (
          <div className="muted" style={{ height: 200, display: "grid", placeItems: "center" }}>Loading…</div>
        ) : me === null ? (
          <SignIn onDone={load} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Hey <b>{me.username}</b></span>
              <span className="balance tnum">🪙 {me.balance.toLocaleString()}</span>
            </div>
            <button className="btn btn-acid" style={{ height: 56, fontSize: 18 }} onClick={() => start(true)} disabled={!!busy}>
              {busy === "bots" ? "Setting the table…" : "Start a table with bots"}
            </button>
            <button className="btn" style={{ height: 52 }} onClick={() => start(false)} disabled={!!busy}>
              {busy === "table" ? "Setting the table…" : "Start an empty table"}
            </button>
            <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (code.trim()) router.push(`/r/${code.trim().toUpperCase()}`); }}>
              <input className="input" style={{ flex: 1, height: 48, fontSize: 16, textTransform: "uppercase", letterSpacing: ".2em" }}
                maxLength={5} placeholder="CODE" aria-label="Table code" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn" style={{ height: 48 }} disabled={code.trim().length !== 5}>Join</button>
            </form>
          </div>
        )}
      </div>

      <ul className="muted" style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 18, margin: "22px 0 0" }}>
        <li>7 or 11 on the come-out wins. 2, 3 or 12 is craps. Anything else is the point.</li>
        <li>Fade the shooter or back them before every roll.</li>
        <li>Dice cocked or off the table? Call <b style={{ color: "var(--pink)" }}>CATCH</b> within 5 seconds and the table votes.</li>
      </ul>
      <style>{`.hero-mark{position:absolute;right:-6px;top:-18px;width:120px;height:120px;opacity:.9;transform:rotate(8deg)}@media(max-width:430px){.hero-mark{width:64px;height:64px;top:-44px;right:0}}`}</style>
    </main>
  );
}
