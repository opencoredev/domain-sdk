import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/docs/quickstart",
        destination: "/docs/installation",
        permanent: true,
      },
      {
        source: "/docs/how-it-works",
        destination: "/docs/providers",
        permanent: true,
      },
      {
        source: "/docs/providers/compatibility",
        destination: "/docs/providers",
        permanent: true,
      },
      {
        source: "/docs/project/provider-adapter-guide",
        destination: "/docs/project/contributing",
        permanent: true,
      },
      {
        source: "/docs/project/sponsorships",
        destination: "/docs/project/contributing",
        permanent: true,
      },
    ];
  },
  // Reverse proxy for PostHog so analytics requests are first-party and
  // survive tracking blockers.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default withMDX(config);
