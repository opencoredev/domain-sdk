"use client";

import * as React from "react";
import {
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function OneClickDnsPreview() {
  const [state, setState] = React.useState<"ready" | "connecting" | "connected">("ready");
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useEffect(() => () => clearTimeout(timerRef.current), []);

  function connect() {
    setState("connecting");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("connected"), 900);
  }

  const connected = state === "connected";
  const connecting = state === "connecting";

  return (
    <section className="dns-records-preview my-8 min-w-0 overflow-hidden rounded-lg border bg-background text-foreground">
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            <HugeiconsIcon
              icon={connected ? CheckmarkCircle02Icon : SecurityCheckIcon}
              className="size-4"
              aria-hidden="true"
            />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold">
              {connected ? "DNS changes approved" : "Set up DNS automatically"}
            </h2>
            <p className="max-w-2xl break-words text-sm text-muted-foreground">
              {connected
                ? "Cloudflare accepted the DNS changes for app.customer-example.com. Propagation may still take a few minutes."
                : "Authorize Cloudflare to add 2 required DNS records for app.customer-example.com."}
            </p>
          </div>
        </div>

        <Button
          type="button"
          className="w-full sm:w-auto sm:shrink-0"
          variant={connected ? "outline" : "default"}
          disabled={connecting || connected}
          onClick={connect}
        >
          <HugeiconsIcon
            icon={connected ? CheckmarkCircle02Icon : ArrowUpRight01Icon}
            data-icon="inline-start"
            aria-hidden="true"
          />
          {connecting ? "Opening Cloudflare…" : connected ? "Approved" : "Continue to Cloudflare"}
        </Button>
      </div>

      <Separator />

      <div className="flex flex-col gap-2 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>You will review every DNS change at Cloudflare before anything is applied.</p>
        {!connected ? (
          <Button type="button" variant="link" size="xs" className="h-auto justify-start px-0">
            Use manual records
          </Button>
        ) : null}
      </div>
    </section>
  );
}
