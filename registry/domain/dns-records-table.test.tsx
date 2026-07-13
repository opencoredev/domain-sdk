import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DnsRecord } from "@opencoredev/domain-sdk";

import { DnsRecordsTable } from "./dns-records-table";

const records: DnsRecord[] = [
  {
    type: "CNAME",
    name: "app.example.com",
    value: "target.example.net",
    purpose: "routing",
    required: true,
    status: "pending",
  },
  {
    type: "TXT",
    name: "_optional.app.example.com",
    value: "optional-token",
    purpose: "ownership",
    required: false,
    status: "valid",
  },
];

afterEach(cleanup);

describe("DnsRecordsTable", () => {
  test("renders a useful empty state and disables bulk copy", () => {
    render(<DnsRecordsTable records={[]} />);

    expect(screen.getAllByText("No DNS records in this view.")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Copy all" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("shows required records by default and can reveal all records", () => {
    render(<DnsRecordsTable records={records} />);
    expect(screen.getAllByText("target.example.net")).toHaveLength(2);
    expect(screen.queryByText("optional-token")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter DNS records"), { target: { value: "all" } });
    expect(screen.getAllByText("optional-token")).toHaveLength(2);
  });

  test("copies a value and announces confirmation", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => expect(value).toBe("target.example.net") },
    });
    render(<DnsRecordsTable records={records} />);
    const copyButton = screen.getAllByRole("button", {
      name: /copy value for app\.example\.com/i,
    })[0];
    copyButton.focus();
    fireEvent.click(copyButton);
    await waitFor(() =>
      expect(screen.getByText("Copied the value for app.example.com.")).toBeTruthy(),
    );
    expect(document.activeElement).toBe(copyButton);
    expect(screen.getByText("Copied the value for app.example.com.")).toBeTruthy();
  });

  test("copies a name from the name cell and identifies the copied field", async () => {
    let copiedField: string | undefined;
    render(
      <DnsRecordsTable
        records={records}
        onCopy={(content, _record, field) => {
          expect(content).toBe("app.example.com");
          copiedField = field;
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /copy name for app\.example\.com/i })[0]);
    await waitFor(() => expect(copiedField).toBe("name"));
    expect(screen.getByText("Copied the name for app.example.com.")).toBeTruthy();
  });

  test("announces clipboard failure with an actionable recovery", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("blocked");
        },
      },
    });
    render(<DnsRecordsTable records={records} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /copy value for app\.example\.com/i })[0],
    );
    await waitFor(() => expect(screen.getByText(/check clipboard permissions/i)).toBeTruthy());
  });
});
