import { NextResponse, type NextRequest } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { createClient } from "@supabase/supabase-js";

// Mints LiveKit tokens. LIVEKIT_API_SECRET lives only here (server env, never NEXT_PUBLIC_).
// The caller must present their Supabase session; identity + display name come from the DB,
// not from the request, so nobody can join video as someone else.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "video not configured" }, { status: 500 });
  }
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return NextResponse.json({ error: "NOT_SIGNED_IN" }, { status: 401 });

  let body: { room?: string; watch?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad body" }, { status: 400 }); }
  const room = String(body.room ?? "").toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(room)) return NextResponse.json({ error: "NO_ROOM" }, { status: 400 });

  const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: ue } = await supa.auth.getUser(jwt);
  if (ue || !u.user) return NextResponse.json({ error: "NOT_SIGNED_IN" }, { status: 401 });
  const [{ data: player }, { data: roomRow }] = await Promise.all([
    supa.from("players").select("id, username").eq("id", u.user.id).maybeSingle(),
    supa.from("rooms").select("id").eq("id", room).maybeSingle(),
  ]);
  if (!player) return NextResponse.json({ error: "NOT_SIGNED_IN" }, { status: 401 });
  if (!roomRow) return NextResponse.json({ error: "NO_ROOM" }, { status: 404 });

  const watch = Boolean(body.watch);
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: watch ? `watch:${player.id}` : player.id,
    name: player.username,
    ttl: "2h",
    metadata: JSON.stringify({ watch }),
  });
  at.addGrant({
    room: `snakeyes-${room}`,
    roomJoin: true,
    canSubscribe: true,
    canPublish: !watch,           // spectators: no camera / mic
    canPublishData: true,         // everyone can chat + react
  });
  return NextResponse.json({ token: await at.toJwt(), url: LIVEKIT_URL }, { headers: { "cache-control": "no-store" } });
}
