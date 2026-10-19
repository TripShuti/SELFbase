import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Providers } from "@/src/providers/Providers";
import { WorkspaceQueryBootstrap } from "@/src/components/WorkspaceQueryBootstrap";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SELFbase",
  description: "Self-hosted, relational-first workspace",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-200`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {/* Must render before Providers so ?ws/?db deep links set the
              active workspace before WorkspaceProvider reads localStorage. */}
          <WorkspaceQueryBootstrap />
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
