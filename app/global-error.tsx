"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/report-error";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError("render.global", error);
  }, [error]);

  return (
    <html lang="he" dir="rtl">
      <body className="fatal-page">
        <main>
          <p className="fatal-mark">Shuv Flow</p>
          <h1>משהו לא נטען כמו שצריך.</h1>
          <p>לא תוצג פעולה לא שלמה. אפשר לנסות לטעון את המסך מחדש.</p>
          <button className="button" onClick={reset}>נסה שוב</button>
        </main>
      </body>
    </html>
  );
}
