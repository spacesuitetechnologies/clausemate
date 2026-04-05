import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let _anon: SupabaseClient | null = null;
let _service: SupabaseClient | null = null;

export function getAnonClient(): SupabaseClient {
  if (!_anon) {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }
    _anon = createClient(supabaseUrl, supabaseAnonKey);
  }
  return _anon;
}

export function getServiceClient(): SupabaseClient {
  if (!_service) {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    _service = createClient(supabaseUrl, supabaseServiceKey);
  }
  return _service;
}

export async function getUserIdFromToken(token: string): Promise<string> {
  const { data, error } = await getAnonClient().auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid or expired token");
  return data.user.id;
}
