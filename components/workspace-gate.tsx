"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { currentWorkspace, type WorkspaceContext } from "@/lib/data";
import { reportClientError } from "@/lib/report-error";
import { getSupabase, isAuthSessionError } from "@/lib/supabase";
import { ErrorState, Spinner } from "./ui";

const Workspace = createContext<WorkspaceContext | null>(null);

export function useWorkspace() {
  const value = useContext(Workspace);
  if (!value) throw new Error("Workspace context is not available");
  return value;
}

export function WorkspaceGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const client = getSupabase();
      const sessionResult = await Promise.race([
        client.auth.getSession(),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("SESSION_TIMEOUT")), 9000)),
      ]);
      if (!sessionResult.data.session) {
        const returnTo = `${window.location.pathname}${window.location.search}`;
        router.replace(`/login/?next=${encodeURIComponent(returnTo)}`);
        return;
      }
      const context = await Promise.race([
        currentWorkspace(client),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("WORKSPACE_TIMEOUT")), 9000)),
      ]);
      if (!context?.organizationId || !context.clinic?.onboarding_completed) {
        router.replace("/onboarding/");
        return;
      }
      setWorkspace(context);
      setStatus("ready");
    } catch (loadError) {
      reportClientError("workspace.load", loadError);
      if (isAuthSessionError(loadError)) {
        await getSupabase().auth.signOut({ scope: "local" });
        const returnTo = `${window.location.pathname}${window.location.search}`;
        router.replace(`/login/?next=${encodeURIComponent(returnTo)}`);
        return;
      }
      setStatus("error");
    }
  }, [router]);

  useEffect(() => {
    void load();
    const client = getSupabase();
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.replace("/login/");
    });
    return () => data.subscription.unsubscribe();
  }, [load, router]);

  if (status === "loading") return <Spinner />;
  if (status === "error") return <ErrorState onRetry={load} />;
  if (!workspace) return <Spinner />;
  return <Workspace.Provider value={workspace}>{children}</Workspace.Provider>;
}
