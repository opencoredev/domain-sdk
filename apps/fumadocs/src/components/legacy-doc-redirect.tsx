"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { track } from "@/lib/analytics";

export function LegacyDocRedirect({ href, label }: { href: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    track("legacy_doc_redirected", { from: window.location.pathname, to: href });
    router.replace(href);
  }, [href, router]);

  return (
    <p aria-live="polite">
      This page moved to <Link href={href}>{label}</Link>.
    </p>
  );
}
