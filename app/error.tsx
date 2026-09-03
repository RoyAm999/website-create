"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui";
import { reportClientError } from "@/lib/report-error";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { reportClientError("render.route", error); }, [error]);
  return <ErrorState onRetry={reset} />;
}
