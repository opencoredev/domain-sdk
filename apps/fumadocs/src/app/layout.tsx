import type { Metadata } from "next";
import { Geist, Outfit } from "next/font/google";
import Script from "next/script";

import { Provider } from "@/components/provider";

import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://domain-sdk.dev"),
  title: { default: "Domain SDK", template: "%s | Domain SDK" },
  description: "Add, verify, monitor, and remove customer domains with one TypeScript API.",
  openGraph: {
    type: "website",
    title: "Domain SDK — Custom domains, handled",
    description: "Add, verify, monitor, and remove customer domains with one TypeScript API.",
    siteName: "Domain SDK",
  },
  twitter: {
    card: "summary_large_image",
    title: "Domain SDK — Custom domains, handled",
    description: "Add, verify, monitor, and remove customer domains with one TypeScript API.",
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geist.className} ${geist.variable} ${outfit.variable}`}
      suppressHydrationWarning
    >
      <head>
        {process.env.NODE_ENV === "development" && (
          <Script
            src="//unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
