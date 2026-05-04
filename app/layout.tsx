import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import { SettingsProvider } from "@/context/SettingsContext";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "Kingston's Running",
  description: "Personal running program for Kingston",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-screen flex flex-col" style={{ background: "var(--background)", color: "var(--text)" }}>
        <SettingsProvider>
          <Nav />
          <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 sm:px-6">
            {children}
          </main>
        </SettingsProvider>
      </body>
    </html>
  );
}
