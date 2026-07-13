"use client";

import * as React from "react";
import type { Domain } from "@opencoredev/domain-sdk";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export interface OneClickDnsSetupProps {
  domain: Domain;
  dnsProvider: string;
  onConnect(domain: Domain): void | Promise<void>;
  onManualSetup?(domain: Domain): void;
  isConnecting?: boolean;
  isConnected?: boolean;
  error?: string;
}

export function OneClickDnsSetup({
  domain,
  dnsProvider,
  onConnect,
  onManualSetup,
  isConnecting = false,
  isConnected = false,
  error,
}: OneClickDnsSetupProps) {
  const headingId = React.useId();
  const requiredRecords = domain.records.filter((record) => record.required).length;
  const description = isConnected
    ? `${dnsProvider} accepted the DNS changes for ${domain.hostname}. Propagation may still take a few minutes.`
    : `Authorize ${dnsProvider} to add ${requiredRecords} required DNS ${requiredRecords === 1 ? "record" : "records"} for ${domain.hostname}.`;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={isConnecting}
      className="min-w-0 overflow-hidden rounded-lg border bg-background text-foreground"
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/30">
            {isConnected ? (
              <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4" aria-hidden="true" />
            ) : error ? (
              <HugeiconsIcon
                icon={Alert02Icon}
                className="size-4 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <HugeiconsIcon icon={SecurityCheckIcon} className="size-4" aria-hidden="true" />
            )}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={headingId} className="text-sm font-semibold">
              {isConnected ? "DNS changes approved" : "Set up DNS automatically"}
            </h2>
            <p className="max-w-2xl break-words text-sm text-muted-foreground">{description}</p>
            {error ? (
              <p className="text-sm text-destructive">
                Automatic setup did not finish: {error} Try again or use the manual records.
              </p>
            ) : null}
          </div>
        </div>

        <Button
          type="button"
          className="w-full sm:w-auto sm:shrink-0"
          variant={isConnected ? "outline" : "default"}
          disabled={isConnecting || isConnected}
          onClick={() => void onConnect(domain)}
        >
          {isConnecting ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="inline-start"
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : isConnected ? (
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              data-icon="inline-start"
              aria-hidden="true"
            />
          ) : (
            <HugeiconsIcon icon={ArrowUpRight01Icon} data-icon="inline-start" aria-hidden="true" />
          )}
          {isConnecting
            ? `Opening ${dnsProvider}…`
            : isConnected
              ? "Approved"
              : `Continue to ${dnsProvider}`}
        </Button>
      </div>

      <Separator />

      <div className="flex flex-col gap-2 bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>You will review every DNS change at {dnsProvider} before anything is applied.</p>
        {onManualSetup && !isConnected ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto justify-start px-0 sm:shrink-0 sm:justify-center"
            onClick={() => onManualSetup(domain)}
          >
            Use manual records
          </Button>
        ) : null}
      </div>

      <span className="sr-only" aria-live="polite">
        {isConnecting
          ? `Opening ${dnsProvider} to authorize DNS changes.`
          : isConnected
            ? `DNS changes were approved for ${domain.hostname}.`
            : error
              ? `Automatic DNS setup failed for ${domain.hostname}. ${error}`
              : ""}
      </span>
    </section>
  );
}
