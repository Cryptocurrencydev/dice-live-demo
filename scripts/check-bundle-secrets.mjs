// Fetches every JS chunk the live site serves and checks none contains a server-only secret. Prints no values.
import { config } from "dotenv";
const env = {}; for (const f of [".env", ".env.local"]) config({ path: f, processEnv: env, override: true, quiet: true });
const base = process.argv[2];
const secrets = { LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY };
const pages = ["/", "/r/ABCDE"];
const chunks = new Set();
for (const p of pages) {
  const html = await (await fetch(base + p)).text();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\s)]+\.js/g)) chunks.add(m[0]);
  for (const [k, v] of Object.entries(secrets)) if (v && html.includes(v)) console.log(`LEAK ${k} in ${p}`);
}
let leaks = 0;
for (const c of chunks) {
  const js = await (await fetch(base + c)).text();
  for (const [k, v] of Object.entries(secrets)) if (v && js.includes(v)) { leaks++; console.log(`LEAK ${k} in ${c}`); }
}
console.log(`checked ${chunks.size} chunks + ${pages.length} pages: ${leaks ? leaks + " LEAKS" : "no server secrets found"}`);
