"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
export function sb() {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "snakeyes-auth" },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return client;
}

/** Demo auth: an anonymous Supabase session + a username claimed through the sign_in RPC.
 *  Production swaps this for phone/SMS OTP via a proven provider (see README). */
export async function ensureSession() {
  const s = sb();
  const { data } = await s.auth.getSession();
  if (data.session) return data.session;
  const { data: d, error } = await s.auth.signInAnonymously();
  if (error) throw error;
  return d.session!;
}

export type Me = { id: string; username: string; balance: number; daily_cap: number; played_today: number; server_now: string };
export async function myStatus(): Promise<Me | null> {
  const { data, error } = await sb().rpc("my_status");
  if (error) throw error;
  return (data as Me) ?? null;
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) throw new GameError(error.message);
  return data as T;
}
export class GameError extends Error {}
