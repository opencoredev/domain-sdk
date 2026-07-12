"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LegacyDocRedirect({ href, label }: { href: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return (
    <p aria-live="polite">
      This page moved to <Link href={href}>{label}</Link>.
    </p>
  );
}
