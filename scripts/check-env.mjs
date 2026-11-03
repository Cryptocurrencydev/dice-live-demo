// Prints which env keys are present — never values.
import { config } from "dotenv";
const out = {};
for (const f of [".env", ".env.local"]) {
  const r = config({ path: f, processEnv: out, override: true, quiet: true });
  if (r.error && r.error.code !== "ENOENT") console.log(f, "error", r.error.code);
}
for (const k of Object.keys(out).sort()) console.log(k.padEnd(32), out[k] ? `set (${out[k].length} chars${/^(https?|wss|postgres(ql)?):\/\//.test(out[k]) ? ", scheme " + out[k].split(":")[0] : ""})` : "EMPTY");
