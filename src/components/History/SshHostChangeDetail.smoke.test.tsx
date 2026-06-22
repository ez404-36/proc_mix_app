// Smoke tests for the SSH "edited" history detail (Field: old > new diff).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SshHostSnapshot } from "../../types";

import "../../i18n";
import { SshHostChangeDetail } from "./SshHostChangeDetail";

function snap(overrides: Partial<SshHostSnapshot> = {}): SshHostSnapshot {
  return {
    hostKey: "open-ssh-config:prod",
    name: "prod",
    source: "open-ssh-config",
    hostName: "prod.example.com",
    user: "deploy",
    port: 22,
    identityFile: null,
    isPattern: false,
    rawText: "Host prod\n    User deploy",
    ...overrides,
  };
}

describe("SshHostChangeDetail", () => {
  it("lists only the changed modelled fields as old > new", () => {
    const before = snap({ user: "deploy", port: 22 });
    const after = snap({ user: "ci", port: 2222, rawText: "Host prod\n    User ci" });
    render(<SshHostChangeDetail before={before} after={after} />);

    // User changed deploy → ci
    expect(screen.getByText("deploy")).toBeTruthy();
    expect(screen.getByText("ci")).toBeTruthy();
    // Port changed 22 → 2222
    expect(screen.getByText("22")).toBeTruthy();
    expect(screen.getByText("2222")).toBeTruthy();
    // Unchanged HostName is NOT shown as a diff row
    expect(screen.queryByText("HostName")).toBeNull();
  });

  it("shows an em-dash when a field is unset on one side", () => {
    const before = snap({ identityFile: null });
    const after = snap({ identityFile: "~/.ssh/id_ed25519", rawText: "changed" });
    render(<SshHostChangeDetail before={before} after={after} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("~/.ssh/id_ed25519")).toBeTruthy();
  });

  it("notes when only the raw block changed (no modelled diff)", () => {
    // Same modelled fields, but raw text differs (e.g. a comment changed).
    const before = snap({ rawText: "Host prod\n    User deploy\n    # note A" });
    const after = snap({ rawText: "Host prod\n    User deploy\n    # note B" });
    render(<SshHostChangeDetail before={before} after={after} />);
    // No modelled-field rows → the "no standard field changes" hint shows.
    expect(screen.getByText(/no changes to the standard fields/i)).toBeTruthy();
    // The full-block disclosure is present.
    expect(screen.getByText(/full block/i)).toBeTruthy();
  });
});
