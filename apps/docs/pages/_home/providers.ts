// Providers on the landing page, in the docs sidebar's order. Each `id` names
// its mark in public/providers/.
export const providers = [
  { id: "vercel", name: "Vercel", href: "/docs/providers/vercel" },
  { id: "cloudflare", name: "Cloudflare for SaaS", href: "/docs/providers/cloudflare" },
  { id: "railway", name: "Railway", href: "/docs/providers/railway" },
  { id: "render", name: "Render", href: "/docs/providers/render" },
  { id: "netlify", name: "Netlify", href: "/docs/providers/netlify" },
  { id: "bunny", name: "bunny.net", href: "/docs/providers/bunny" },
  { id: "porkbun", name: "Porkbun", href: "/docs/providers/porkbun" },
  { id: "namecheap", name: "Namecheap", href: "/docs/providers/namecheap" },
  { id: "spaceship", name: "Spaceship", href: "/docs/providers/spaceship" },
] as const;
