import type { Metadata, Viewport } from "next";
import { ClientErrorObserver } from "@/components/client-error-observer";
import "./globals.css";
import "./flow.css";

export const metadata: Metadata = {
  title: "Shuv Flow | יודעים למי שווה לחזור היום",
  description: "Shuv Flow עוזר למרפאות לזהות פניות שכדאי לחזור אליהן רק כשיש סיבה אמיתית.",
  icons: { icon: "/shuv-flow-logo.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F7F4EC",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" dir="rtl">
      <body>
        <ClientErrorObserver />
        {children}
      </body>
    </html>
  );
}
