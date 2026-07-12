# Domain SDK documentation

This Fumadocs application contains the Domain SDK website and documentation. The SDK implementation lives in `packages/sdk`.

From the repository root:

```bash
bun install
bun run dev
```

Portless starts the local HTTPS proxy automatically and serves the site at:

```text
https://domain-sdk.localhost:1355
```

The proxy uses unprivileged port `1355`, so it never prompts for `sudo`. Linked Git worktrees receive a branch-prefixed subdomain automatically. To bypass Portless and use Next.js directly:

```bash
PORTLESS=0 bun run dev
```

Other checks are run from the repository root:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Documentation content is in `content/docs`, the landing page is in `src/app/(home)`, and generated `.source`, `.next`, and `out` files must not be committed.
