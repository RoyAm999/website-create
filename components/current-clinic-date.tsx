"use client";

import { useEffect, useState } from "react";
import { formatClinicDate } from "@/lib/clinic-time";

export function CurrentClinicDate({ preview = false }: { preview?: boolean }) {
  // Keep the server and first browser render identical. The exact clinic date
  // is filled immediately after hydration and remains independent of device TZ.
  const [label, setLabel] = useState("היום");

  useEffect(() => {
    const update = () => {
      const formatted = formatClinicDate(new Date(), { weekday: "long", day: "numeric", month: "long" });
      setLabel(preview ? formatted.replace(", ", " · ") : formatted);
    };
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [preview]);

  return <>{label}</>;
}
