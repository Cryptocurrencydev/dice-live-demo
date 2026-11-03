// Copies the runtime env vars from .env/.env.local into the linked Vercel project WITHOUT printing values.
// The service-role key is deliberately NOT pushed: the app never needs it (all writes go through RPCs).
import { config } from "dotenv";
import { spawnSync } from "node:child_process";
const env = {};
for (const f of [".env", ".env.local"]) config({ path: f, processEnv: env, override: true, quiet: true });
const keys = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
for (const k of keys) {
  if (!env[k]) { console.log(`${k}: MISSING locally, skipped`); continue; }
  for (const target of ["production", "preview", "development"]) {
    spawnSync("vercel", ["env", "rm", k, target, "--yes"], { stdio: "ignore" });
    const r = spawnSync("vercel", ["env", "add", k, target], { input: env[k], encoding: "utf8" });
    console.log(`${k} -> ${target}: ${r.status === 0 ? "ok" : "FAILED " + (r.stderr || "").split("\n").filter(Boolean).slice(-1)[0]}`);
  }
}
