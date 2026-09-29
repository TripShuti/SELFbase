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
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%2318181b'/><text x='50' y='68' font-size='58' font-family='sans-serif' font-weight='bold' text-anchor='middle' fill='white'>S</text></svg>",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-200`}
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
