// First-party reverse proxy for PostHog, so analytics requests come from this
// domain and survive tracking blockers. The Fumadocs site did this with
// Next.js rewrites; this endpoint runs in the Vercel function, mounted by
// integrations/site.ts.
//   /ingest/static/* -> https://us-assets.i.posthog.com/static/*
//   /ingest/*        -> https://us.i.posthog.com/*
import type { APIRoute } from "astro";

export const prerender = false;

const API_HOST = "https://us.i.posthog.com";
const ASSET_HOST = "https://us-assets.i.posthog.com";

// Hop-by-hop, host-specific, and credential headers that must not be forwarded.
const DROPPED_REQUEST_HEADERS = ["host", "connection", "cookie", "authorization", "content-length"];

/** The PostHog URL an /ingest request maps to. */
export const upstreamUrl = (url: URL): URL => {
  const rawPath = url.pathname.replace(/^\/ingest/, "") || "/";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const host = path.startsWith("/static/") ? ASSET_HOST : API_HOST;
  const target = new URL(host);
  target.pathname = path;
  target.search = url.search;
  return target;
};

export const ALL: APIRoute = async ({ request, url }) => {
  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(upstreamUrl(url), {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  // fetch already decoded the body, so the original encoding no longer applies,
  // and upstream analytics responses must not set cookies on this domain.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};
