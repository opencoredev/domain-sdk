// First-party reverse proxy for PostHog, so analytics requests come from this
// domain and survive tracking blockers. The Fumadocs site did this with
// Next.js rewrites; this endpoint runs in the Vercel function, mounted by
// integrations/site.ts.
//   /ingest/static/* -> https://us-assets.i.posthog.com/static/*
//   /ingest/*        -> https://us.i.posthog.com/*
import { isIP } from "node:net";
import type { APIRoute } from "astro";

export const prerender = false;

const API_HOST = "https://us.i.posthog.com";
const ASSET_HOST = "https://us-assets.i.posthog.com";

// Internal query flag added by the trailing-slash rewrite so Astro's
// `trailingSlash: "never"` does not redirect `/ingest/*/` before reaching this
// handler. Stripped before forwarding to PostHog.
export const TRAILING_SLASH_PARAM = "__ts";

// Only forward headers PostHog needs; drop credentials, host/hop-by-hop, and
// platform internals (`x-vercel-*`, `x-astro-*`, `x-forwarded-*`).
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-encoding",
  "content-type",
  "origin",
  "referer",
  "user-agent",
]);

/** The PostHog URL an /ingest request maps to. */
export const upstreamUrl = (url: URL): URL => {
  const params = new URLSearchParams(url.search);
  const hadTrailingSlash = params.has(TRAILING_SLASH_PARAM);
  params.delete(TRAILING_SLASH_PARAM);

  const rawPath = url.pathname.replace(/^\/ingest/, "") || "/";
  let path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (hadTrailingSlash && !path.endsWith("/")) {
    path = `${path}/`;
  }
  const host = path.startsWith("/static/") ? ASSET_HOST : API_HOST;
  const target = new URL(host);
  target.pathname = path;
  const nextSearch = params.toString();
  target.search = nextSearch ? `?${nextSearch}` : "";
  return target;
};

function validIp(raw: string | null | undefined): string | undefined {
  const firstHop = raw?.split(",")[0]?.trim();
  if (!firstHop || isIP(firstHop) === 0) return undefined;
  return firstHop;
}

function resolveClientIp(context: Parameters<APIRoute>[0]): string | undefined {
  for (const header of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const ip = validIp(context.request.headers.get(header));
    if (ip) return ip;
  }
  try {
    return validIp(context.clientAddress);
  } catch {
    // @astrojs/vercel's clientAddress getter throws when x-forwarded-for is absent.
  }
  return undefined;
}

export const ALL: APIRoute = async (context) => {
  const { request, url } = context;
  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  const clientIp = resolveClientIp(context);
  if (clientIp) {
    headers.set("x-forwarded-for", clientIp);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(url), {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    return new Response(null, { status: 502 });
  }
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
