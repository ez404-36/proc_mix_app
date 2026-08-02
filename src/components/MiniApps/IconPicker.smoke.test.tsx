// Smoke tests for the Mini-App icon picker.
//
// Only Arco's `Message` is mocked (the picker's validation surface); the
// upload path exercises the REAL `File.arrayBuffer()` → base64 `data:` URI
// conversion, because a mocked reader would hide exactly the bug the
// conversion can have.

import { useState } from "react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import { Message } from "@arco-design/web-react";
import { IconPicker } from "./IconPicker";

const DATA_URI_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Hard cap the picker enforces on an uploaded icon. */
const MAX_ICON_BYTES = 50 * 1024;

interface HarnessProps {
  initialValue?: string | undefined;
  onValueChange?: (icon: string | undefined) => void;
}

/** Controlled wrapper mirroring how the editor owns `MiniApp.icon`. */
function Harness({ initialValue, onValueChange }: HarnessProps): ReactElement {
  const [value, setValue] = useState<string | undefined>(initialValue);
  return (
    <IconPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
    />
  );
}

function emojiButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Emoji" }) as HTMLButtonElement;
}

function fileInput(): HTMLInputElement {
  return document.querySelector(".icon-picker__file-input") as HTMLInputElement;
}

/**
 * Fire a file selection through the picker's hidden `<input type="file">` and
 * wait for the async `arrayBuffer()` read to settle. The read resolves on a
 * macrotask (jsdom's `FileReader`), so a bare microtask flush is not enough.
 */
async function upload(file: File): Promise<void> {
  act(() => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  });
  // Let any queued `onChange` / `Message.error` land before the assertions.
  await waitFor(() => {
    expect(fileInput().value).toBe("");
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("IconPicker — current icon", () => {
  it("renders a placeholder glyph when no icon is set", () => {
    render(<Harness />);

    const placeholder = document.querySelector(".icon-picker__placeholder");
    expect(placeholder?.textContent).toBe("✦");
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders an emoji icon as literal text", () => {
    render(<Harness initialValue="🔌" />);

    const preview = document.querySelector(".icon-picker__preview");
    expect(preview?.textContent).toBe("🔌");
    expect(preview?.querySelector("img")).toBeNull();
  });

  it("renders a data-URI icon as an <img> with that src", () => {
    render(<Harness initialValue={DATA_URI_ICON} />);

    const img = document.querySelector(".icon-picker__preview img");
    expect(img?.getAttribute("src")).toBe(DATA_URI_ICON);
  });
});

describe("IconPicker — emoji grid", () => {
  it("is closed until the Emoji button is pressed", () => {
    render(<Harness />);

    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
    expect(emojiButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a grid of keyboard-reachable emoji buttons", () => {
    render(<Harness />);

    act(() => {
      fireEvent.click(emojiButton());
    });

    const grid = screen.getByRole("group", { name: "Emoji" });
    expect(emojiButton().getAttribute("aria-expanded")).toBe("true");
    // Every entry is a real <button>, not a div — so Tab / Enter work.
    const entries = within(grid).getAllByRole("button");
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.every((el) => el.tagName === "BUTTON")).toBe(true);
  });

  it("selecting an emoji commits it and closes the grid", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    const grid = screen.getByRole("group", { name: "Emoji" });
    act(() => {
      fireEvent.click(within(grid).getByRole("button", { name: "🔌" }));
    });

    expect(onValueChange).toHaveBeenCalledWith("🔌");
    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
  });

  it("marks the currently-selected emoji with aria-pressed", () => {
    render(<Harness initialValue="🔌" />);

    act(() => {
      fireEvent.click(emojiButton());
    });

    const grid = screen.getByRole("group", { name: "Emoji" });
    expect(
      within(grid)
        .getByRole("button", { name: "🔌" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(grid)
        .getByRole("button", { name: "⚡" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("pressing Emoji again toggles the grid closed", () => {
    render(<Harness />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    act(() => {
      fireEvent.click(emojiButton());
    });

    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
  });

  it("Escape closes the grid", () => {
    render(<Harness />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
  });

  it("an outside pointer-down closes the grid", () => {
    render(<Harness />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    act(() => {
      fireEvent.mouseDown(document.body);
    });

    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
  });

  it("a pointer-down inside the picker keeps the grid open", () => {
    render(<Harness />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    act(() => {
      fireEvent.mouseDown(emojiButton());
    });

    expect(screen.getByRole("group", { name: "Emoji" })).toBeTruthy();
  });
});

describe("IconPicker — clear", () => {
  it("offers no Clear action while there is no icon", () => {
    render(<Harness />);

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("Clear removes the icon", () => {
    const onValueChange = vi.fn();
    render(<Harness initialValue="🔌" onValueChange={onValueChange} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });

    expect(onValueChange).toHaveBeenCalledWith(undefined);
    expect(document.querySelector(".icon-picker__placeholder")).not.toBeNull();
  });

  it("Clear also closes an open emoji grid", () => {
    render(<Harness initialValue="🔌" />);

    act(() => {
      fireEvent.click(emojiButton());
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });

    expect(screen.queryByRole("group", { name: "Emoji" })).toBeNull();
  });
});

describe("IconPicker — upload", () => {
  it("accepts a small PNG and stores it as a base64 data URI", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    // "PNG" as bytes — the MIME is derived from the extension, not the blob.
    await upload(new File([new Uint8Array([80, 78, 71])], "icon.png"));

    expect(onValueChange).toHaveBeenCalledWith("data:image/png;base64,UE5H");
  });

  it("accepts an SVG and tags it image/svg+xml", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File(["<svg/>"], "icon.svg"));

    const [icon] = onValueChange.mock.calls[0] as [string];
    expect(icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("matches the extension case-insensitively", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File([new Uint8Array([80])], "ICON.PNG"));

    expect(onValueChange).toHaveBeenCalledWith("data:image/png;base64,UA==");
  });

  it("renders the uploaded icon in the preview", async () => {
    render(<Harness />);

    await upload(new File([new Uint8Array([80, 78, 71])], "icon.png"));

    expect(
      document.querySelector(".icon-picker__preview img")?.getAttribute("src"),
    ).toBe("data:image/png;base64,UE5H");
  });

  it("rejects a non-SVG/PNG file with an explanatory toast", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File(["gif"], "icon.gif"));

    expect(Message.error).toHaveBeenCalledWith(
      "Only SVG and PNG are supported",
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("rejects an extensionless file", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File(["x"], "icon"));

    expect(Message.error).toHaveBeenCalledWith(
      "Only SVG and PNG are supported",
    );
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("rejects a file over 50KB with an explanatory toast", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(
      new File([new Uint8Array(MAX_ICON_BYTES + 1)], "big.png"),
    );

    expect(Message.error).toHaveBeenCalledWith("File too large (max 50KB)");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("accepts a file exactly at the 50KB boundary", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File([new Uint8Array(MAX_ICON_BYTES)], "edge.png"));

    expect(Message.error).not.toHaveBeenCalled();
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("lets the SAME file be re-picked after a rejection", async () => {
    // The picker clears the input's value after every pick; without that a
    // second `change` for an identical file would never fire, and a user who
    // fixed the file on disk could not retry.
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    await upload(new File(["gif"], "icon.gif"));
    expect(Message.error).toHaveBeenCalledTimes(1);

    await upload(new File(["gif"], "icon.gif"));
    expect(Message.error).toHaveBeenCalledTimes(2);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("is a no-op when the dialog is dismissed with no file", async () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    act(() => {
      fireEvent.change(fileInput(), { target: { files: [] } });
    });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(Message.error).not.toHaveBeenCalled();
  });

  it("restricts the native dialog to SVG and PNG", () => {
    render(<Harness />);

    expect(fileInput().getAttribute("accept")).toBe(
      ".svg,.png,image/svg+xml,image/png",
    );
  });
});
