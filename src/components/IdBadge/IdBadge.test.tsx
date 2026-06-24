// Tests for IdBadge: renders the id and copies it to the clipboard on click.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Arco's `Message` renders via a legacy ReactDOM.render that throws under
// jsdom; the toast is incidental to what we're testing, so stub it out.
vi.mock("@arco-design/web-react", () => ({
  Message: { success: vi.fn(), error: vi.fn() },
}));

import "../../i18n";
import { IdBadge } from "./IdBadge";

afterEach(() => {
  vi.restoreAllMocks();
});

const ID = "a1b2c3d4-1111-2222-3333-444455556666";

describe("IdBadge", () => {
  it("renders the id value", () => {
    render(<IdBadge id={ID} />);
    expect(screen.getByText(ID)).toBeTruthy();
  });

  it("copies the id to the clipboard when the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard; install a minimal stub for this test.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<IdBadge id={ID} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(ID);
    });
  });
});
