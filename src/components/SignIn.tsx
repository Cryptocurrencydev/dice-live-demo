"use client";
import { useEffect, useState } from "react";
import { ensureSession, GameError, rpc } from "@/lib/supabase";
import { ERROR_COPY } from "@/lib/rules";

/** Username-only sign-in for the demo. Production: phone/SMS OTP through a proven provider. */
export function SignIn({ onDone, cta = "Let's roll" }: { onDone: () => void; cta?: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // restore the last name from this device (localStorage isn't available during SSR)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setName(localStorage.getItem("snakeyes-name") ?? ""); } catch {}
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await ensureSession();
      await rpc("sign_in", { p_username: name.trim() });
      try { localStorage.setItem("snakeyes-name", name.trim()); } catch {}
      onDone();
    } catch (e) {
      const code = e instanceof GameError ? e.message : "";
      setErr(ERROR_COPY[code] ?? "Couldn't sign in. Try again.");
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="field" style={{ gap: 10 }}>
      <label htmlFor="username">Pick a street name</label>
      <input id="username" className="input" autoComplete="nickname" autoCapitalize="off" spellCheck={false}
        maxLength={16} placeholder="e.g. lucky_lou" value={name} onChange={(e) => setName(e.target.value)}
        aria-invalid={!!err} aria-describedby="name-help" />
      <div id="name-help" className="muted" style={{ fontSize: 12, minHeight: 16 }} role={err ? "alert" : undefined}>
        {err ?? "2–16 letters, numbers or _. Demo sign-in: no phone needed."}
      </div>
      <button className="btn btn-acid" style={{ height: 54, fontSize: 17 }} disabled={busy || name.trim().length < 2}>
        {busy ? "Signing in…" : cta}
      </button>
    </form>
  );
}
