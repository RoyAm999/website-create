import { getSupabase } from "./supabase";

const MAX_RECENT_ERRORS = 8;

type ErrorDetails = {
  name: string;
  message: string;
  stack: string | null;
  digest?: string;
};

function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    const digest = "digest" in error && typeof error.digest === "string" ? error.digest.slice(0, 160) : undefined;
    return {
      name: error.name.slice(0, 120),
      message: error.message.slice(0, 600),
      stack: error.stack?.slice(0, 2400) || null,
      ...(digest ? { digest } : {}),
    };
  }
  return { name: "UnknownError", message: String(error || "Unknown error").slice(0, 600), stack: null };
}

function eventId() {
  try { return crypto.randomUUID(); }
  catch { return `sf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
}

function clientContext() {
  if (typeof window === "undefined") return {};
  return {
    path: window.location.pathname.slice(0, 300),
    online: navigator.onLine,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    occurred_at: new Date().toISOString(),
  };
}

function rememberLocally(entry: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const key = "shuv-flow-recent-errors";
    const previous = JSON.parse(window.sessionStorage.getItem(key) || "[]");
    const items = Array.isArray(previous) ? previous.slice(-(MAX_RECENT_ERRORS - 1)) : [];
    window.sessionStorage.setItem(key, JSON.stringify([...items, entry]));
  } catch {
    // Diagnostics must never cause another customer-facing failure.
  }
}

export function reportClientError(scope: string, error: unknown, organizationId?: string): string {
  const details = errorDetails(error);
  const id = eventId();
  const entry = { id, scope: scope.slice(0, 160), ...details, ...clientContext() };
  console.error(`[Shuv Flow:${id}] ${scope}`, error, entry);
  rememberLocally(entry);

  if (organizationId) {
    try {
      void getSupabase()
        .rpc("sf_report_client_error", {
          p_organization_id: organizationId,
          p_details: entry,
        })
        .then(
          ({ error: logError }) => {
            if (logError) console.error("[Shuv Flow] Failed to persist client error", logError);
          },
          (logError: unknown) => console.error("[Shuv Flow] Failed to persist client error", logError),
        );
    } catch (logError) {
      console.error("[Shuv Flow] Failed to initialize client error reporting", logError);
    }
  }

  return id;
}
