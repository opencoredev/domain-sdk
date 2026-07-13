import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Domain } from "@opencoredev/domain-sdk";

import { OneClickDnsSetup } from "./one-click-dns-setup";

const domain: Domain = {
  id: "domain_123",
  hostname: "app.example.com",
  provider: "vercel",
  status: "pending_dns",
  records: [
    {
      type: "CNAME",
      name: "app.example.com",
      value: "target.example.net",
      purpose: "routing",
      required: true,
      status: "pending",
    },
  ],
  verification: { status: "pending", records: [] },
  certificate: { status: "pending" },
  issues: [],
};

afterEach(cleanup);

describe("OneClickDnsSetup", () => {
  test("starts controlled automatic setup for the SDK domain", () => {
    let selected: Domain | undefined;
    render(
      <OneClickDnsSetup
        domain={domain}
        dnsProvider="Cloudflare"
        onConnect={(value) => {
          selected = value;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue to Cloudflare" }));
    expect(selected).toBe(domain);
  });

  test("prevents duplicate submissions while the authorization flow opens", () => {
    render(
      <OneClickDnsSetup
        domain={domain}
        dnsProvider="Cloudflare"
        isConnecting
        onConnect={() => undefined}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Opening Cloudflare…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Opening Cloudflare to authorize DNS changes.")).toBeTruthy();
  });

  test("offers an actionable manual fallback after failure", () => {
    let manual = false;
    render(
      <OneClickDnsSetup
        domain={domain}
        dnsProvider="Cloudflare"
        error="Cloudflare authorization was cancelled."
        onConnect={() => undefined}
        onManualSetup={() => {
          manual = true;
        }}
      />,
    );

    expect(screen.getAllByText(/authorization was cancelled/i)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Use manual records" }));
    expect(manual).toBe(true);
  });
});
