import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = localFont({
  src: "../../public/fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "../../public/fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

// viewport-fit=cover is the prerequisite for env(safe-area-inset-*) —
// without it the toast viewport's notch paddings are silently zero.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// The controller is a private operator panel (PRD-CONTROLLER §11) —
// static metadata only, no DB-driven branding, no public SEO surface.
export const metadata: Metadata = {
  title: "Tweetfess Controller",
  description:
    "Panel kontrol multi-instance untuk menfess — kelola instance, moderasi antrean, dan audit tindakan dari satu tempat.",
  robots: { index: false, follow: false },
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      {/* Page canvas (bg + ink + accent glow) is owned by the `body` rule in
          globals.css @layer base — no bg/text utilities here, they would
          override var(--bg) via the utilities layer. */}
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
