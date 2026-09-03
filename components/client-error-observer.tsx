"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/report-error";

export function ClientErrorObserver() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      reportClientError("window.error", event.error || new Error(event.message || "Unknown window error"));
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      reportClientError("window.unhandled-rejection", event.reason);
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
