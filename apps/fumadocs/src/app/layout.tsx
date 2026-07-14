import type { Metadata } from "next";
import { Geist, Outfit } from "next/font/google";
import Script from "next/script";

import { JsonLd } from "@/components/json-ld";
import { Provider } from "@/components/provider";
import { absoluteUrl, siteConfig } from "@/lib/seo";

import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: { default: siteConfig.title, template: "%s | Domain SDK" },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  authors: [{ name: "OpenCoreDev", url: "https://github.com/opencoredev" }],
  creator: "OpenCoreDev",
  publisher: "OpenCoreDev",
  category: "Developer Tools",
  alternates: { canonical: absoluteUrl("/") },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    url: "/",
    title: siteConfig.title,
    description: siteConfig.description,
    siteName: siteConfig.name,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.title,
    description: siteConfig.description,
  },
};

const websiteSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": absoluteUrl("/#organization"),
      name: "OpenCoreDev",
      url: "https://github.com/opencoredev",
      sameAs: ["https://github.com/opencoredev"],
    },
    {
      "@type": "WebSite",
      "@id": absoluteUrl("/#website"),
      url: absoluteUrl("/"),
      name: siteConfig.name,
      description: siteConfig.description,
      inLanguage: "en-US",
      publisher: { "@id": absoluteUrl("/#organization") },
    },
  ],
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
        <JsonLd data={websiteSchema} />
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
