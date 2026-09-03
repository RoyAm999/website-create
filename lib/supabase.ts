import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_URL = "https://inmftuoucmdypbautxaj.supabase.co";
const DEFAULT_KEY = "sb_publishable_8xckXSs2OVPl5NmV2GBP0A_j0JrW5Mv";

let browserClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY;

  browserClient = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "shuv-flow-session",
    },
    global: {
      headers: { "x-client-info": "shuv-flow-web/1.0" },
    },
  });

  return browserClient;
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/invalid login/i.test(message)) return "האימייל או הסיסמה אינם נכונים.";
  if (/email.*confirm/i.test(message)) return "צריך לאשר את האימייל לפני ההתחברות.";
  if (/already registered/i.test(message)) return "כבר קיים חשבון עם האימייל הזה.";
  if (/network|fetch/i.test(message)) return "לא הצלחנו להתחבר. בדקו את החיבור ונסו שוב.";
  return "משהו לא נטען כמו שצריך. נסו שוב.";
}

export function isAuthSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /jwt|session|refresh.?token|auth.*required|not authenticated|user.*not found/i.test(message);
}
