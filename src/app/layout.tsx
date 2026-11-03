import type { Metadata, Viewport } from "next";
import { Anton, Space_Grotesk } from "next/font/google";
import "./globals.css";

const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-anton", display: "swap" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk", display: "swap" });

export const metadata: Metadata = {
  title: "SNAKEYES — live street dice",
  description: "Live-video street dice with friends. Free coins only. Demo by DC Tech.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#09090a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${grotesk.variable}`}>
      <body>
        {children}
        <footer className="footer">
          Free coins only. No real-money play. <span aria-hidden>·</span> <b>Demo by <a href="https://dctechltd.com" target="_blank" rel="noopener" style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 3 }}>DC Tech</a></b>
        </footer>
      </body>
    </html>
  );
}
