// Smoke tests for the artifact-reference text field used across the Mini-App
// editor's properties panel.
//
// The component is fully controlled, so every test drives it through a small
// stateful harness — that is the only way the `${name}` insertion (which
// rewrites `value` AND repositions the cursor) can be observed the way the
// editor sees it. No IPC is involved, so only Arco's `Message` is mocked to
// match the sibling smoke tests' module graph.

import { useState } from "react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// `shellSyntax` fields resolve utility/flag highlighting through the same
// `fetch_utility_help` / `parse_utility_flags` IPC commands as the command
// form's ScriptEditor. Mocked before importing the component (which pulls
// in the service that binds `invoke` at module load).
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import "../../i18n";
import { __clearUtilityHelpCacheForTests } from "../../hooks/useUtilityHelp";
import { ContextMenuProvider } from "../ContextMenu";
import { ArtifactRefInput } from "./ArtifactRefInput";

/** Wrap every render in a real ContextMenuProvider: the field now attaches a
 *  native `contextmenu` handler that resolves the menu through `useContextMenu`,
 *  so the provider must be present for the component to mount. */
function render(ui: ReactElement): RenderResult {
  return rtlRender(<ContextMenuProvider>{ui}</ContextMenuProvider>);
}

interface HarnessProps {
  initialValue?: string;
  artifactNames?: string[];
  invalid?: boolean;
  multiline?: boolean;
  shellSyntax?: boolean;
  onValueChange?: (value: string) => void;
}

/**
 * Controlled wrapper mirroring how the properties panel owns the field's
 * value. `onValueChange` lets a test assert on the exact emitted string.
 */
function Harness({
  initialValue = "",
  artifactNames = ["configPath", "region"],
  invalid = false,
  multiline = false,
  shellSyntax = false,
  onValueChange,
}: HarnessProps): ReactElement {
  const [value, setValue] = useState(initialValue);
  return (
    <ArtifactRefInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
      artifactNames={artifactNames}
      invalid={invalid}
      multiline={multiline}
      shellSyntax={shellSyntax}
      ariaLabel="Script"
      placeholder="echo hello"
    />
  );
}

function field(): HTMLInputElement {
  return screen.getByLabelText("Script") as HTMLInputElement;
}

/**
 * Type `text` into the field with the cursor left at the end, which is what a
 * real keystroke sequence produces. `fireEvent.change` alone leaves
 * `selectionStart` at 0 in jsdom, and the `${` autocomplete keys off the
 * cursor — so the selection is set explicitly before the event.
 */
function typeInto(text: string, cursor = text.length): void {
  const el = field();
  act(() => {
    fireEvent.change(el, { target: { value: text } });
    el.setSelectionRange(cursor, cursor);
    fireEvent.keyUp(el, { key: "a" });
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  __clearUtilityHelpCacheForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ArtifactRefInput — ${ autocomplete", () => {
  it("opens the dropdown as soon as `${` is typed", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();

    typeInto("echo ${");

    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("filters the options by the typed prefix", () => {
    render(<Harness />);

    typeInto("echo ${con");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe("${configPath}");
  });

  it("filters case-insensitively", () => {
    render(<Harness />);

    typeInto("echo ${CONF");

    expect(screen.getAllByRole("option")[0].textContent).toBe("${configPath}");
  });

  it("selecting an option COMPLETES the open token rather than nesting it", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("echo ${con");
    act(() => {
      fireEvent.mouseDown(screen.getByText("${configPath}"));
    });

    expect(onValueChange).toHaveBeenLastCalledWith("echo ${configPath}");
  });

  it("preserves the text after the cursor when completing", () => {
    render(<Harness />);

    // Cursor sits right after `${con`, with ` --now` trailing behind it.
    typeInto("echo ${con --now", 10);
    act(() => {
      fireEvent.mouseDown(screen.getByText("${configPath}"));
    });

    expect(field().value).toBe("echo ${configPath} --now");
  });

  it("does NOT open for an already-closed token", () => {
    render(<Harness />);

    typeInto("echo ${configPath}");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does NOT open for a prefix that cannot start an identifier", () => {
    render(<Harness />);

    typeInto("echo ${9foo");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the empty state when nothing matches the prefix", () => {
    render(<Harness />);

    typeInto("echo ${zzz");

    expect(
      screen.getByText("No artifacts yet. Add an artifact widget first."),
    ).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores empty artifact names", () => {
    render(<Harness artifactNames={["", "region"]} />);

    typeInto("echo ${");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe("${region}");
  });
});

describe("ArtifactRefInput — keyboard navigation", () => {
  it("ArrowDown then Enter selects the first option", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onValueChange).toHaveBeenLastCalledWith("${configPath}");
  });

  it("ArrowDown twice reaches the second option", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onValueChange).toHaveBeenLastCalledWith("${region}");
  });

  it("ArrowUp from the top wraps to the last option", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      fireEvent.keyDown(field(), { key: "ArrowUp" });
    });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onValueChange).toHaveBeenLastCalledWith("${region}");
  });

  it("ArrowDown past the end wraps back to the first option", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onValueChange).toHaveBeenLastCalledWith("${configPath}");
  });

  it("marks the active option with aria-selected", () => {
    render(<Harness />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });

    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("Enter with nothing highlighted does not insert", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    typeInto("${");
    onValueChange.mockClear();
    act(() => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe("ArtifactRefInput — dismissal", () => {
  it("Escape from the field closes the dropdown", () => {
    render(<Harness />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(field(), { key: "Escape" });
    });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape anywhere in the document closes the dropdown", () => {
    render(<Harness />);

    typeInto("${");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("an outside pointer-down closes the dropdown", () => {
    render(<Harness />);

    typeInto("${");
    act(() => {
      fireEvent.mouseDown(document.body);
    });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a pointer-down INSIDE the wrapper keeps the dropdown open", () => {
    render(<Harness />);

    typeInto("${");
    act(() => {
      fireEvent.mouseDown(field());
    });

    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("ArtifactRefInput — validation and variants", () => {
  it("applies input--error and aria-invalid when invalid", () => {
    render(<Harness invalid />);

    const el = field();
    expect(el.className).toContain("input--error");
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  it("carries neither marker when valid", () => {
    render(<Harness />);

    const el = field();
    expect(el.className).not.toContain("input--error");
    expect(el.getAttribute("aria-invalid")).toBe("false");
  });

  it("renders a textarea in the multiline variant", () => {
    render(<Harness multiline />);

    expect(field().tagName).toBe("TEXTAREA");
  });

  it("the multiline variant supports the same ${ autocomplete", () => {
    render(<Harness multiline />);

    typeInto("echo ${con");

    expect(screen.getAllByRole("option")[0].textContent).toBe("${configPath}");
  });

  it("forwards the placeholder to the field", () => {
    render(<Harness />);

    expect(screen.getByPlaceholderText("echo hello")).toBeTruthy();
  });
});

describe("ArtifactRefInput — syntax highlighting", () => {
  it("paints a known artifact ref with the --known class", () => {
    render(<Harness initialValue="openvpn3 --config ${configPath}" />);

    const known = document.querySelector(".artifact-ref-input__var--known");
    expect(known).not.toBeNull();
    expect(known?.textContent).toBe("${configPath}");
  });

  it("paints an unknown ref with the --unknown class", () => {
    render(<Harness initialValue="echo ${notAnArtifact}" />);

    const unknown = document.querySelector(".artifact-ref-input__var--unknown");
    expect(unknown).not.toBeNull();
    expect(unknown?.textContent).toBe("${notAnArtifact}");
  });

  it("distinguishes known from unknown in the same value", () => {
    render(<Harness initialValue="${region} then ${bogus}" />);

    expect(
      document.querySelector(".artifact-ref-input__var--known")?.textContent,
    ).toBe("${region}");
    expect(
      document.querySelector(".artifact-ref-input__var--unknown")?.textContent,
    ).toBe("${bogus}");
  });

  it("keeps the overlay out of the accessibility tree", () => {
    render(<Harness initialValue="${region}" />);

    const overlay = document.querySelector(".artifact-ref-input__overlay");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");
  });

  it("makes the field text transparent via the --overlay modifier", () => {
    render(<Harness />);

    expect(field().className).toContain("artifact-ref-input__field--overlay");
  });
});

describe("ArtifactRefInput — shell-syntax highlighting (script fields)", () => {
  it("highlights the leading utility and its flags when shellSyntax is enabled", async () => {
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "fetch_utility_help") {
        return Promise.resolve({
          utility: (args as { utility: string }).utility,
          status: "found",
          source: "help",
          text: "Usage: openvpn3 session-start --config <FILE>",
          truncated: false,
        });
      }
      if (cmd === "parse_utility_flags") {
        return Promise.resolve({
          positionalArgs: [],
          flags: [
            {
              flags: ["--config"],
              takesValue: true,
              valueHint: "FILE",
              description: "Config file",
              required: false,
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    render(
      <Harness
        initialValue="openvpn3 session-start --config"
        shellSyntax
        multiline
      />,
    );

    await waitFor(() => {
      const utility = document.querySelector(
        ".command-form__script-editor-utility",
      );
      expect(utility).not.toBeNull();
      expect(utility?.textContent).toBe("openvpn3");
      expect(utility?.className).toContain(
        "command-form__script-editor-utility--found",
      );
    });

    await waitFor(() => {
      const flag = document.querySelector(
        ".command-form__script-editor-flag",
      );
      expect(flag).not.toBeNull();
      expect(flag?.textContent).toBe("--config");
      expect(flag?.className).toContain(
        "command-form__script-editor-flag--found",
      );
    });
  });

  it("does NOT add utility/flag classes when shellSyntax is not enabled", () => {
    render(
      <Harness initialValue="openvpn3 session-start --config" multiline />,
    );

    expect(
      document.querySelector(".command-form__script-editor-utility"),
    ).toBeNull();
    expect(
      document.querySelector(".command-form__script-editor-flag"),
    ).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still applies ONLY ${var} highlighting on non-script fields regardless of content", () => {
    render(
      <Harness
        initialValue="openvpn3 --config ${configPath}"
        artifactNames={["configPath"]}
      />,
    );

    expect(
      document.querySelector(".artifact-ref-input__var--known")?.textContent,
    ).toBe("${configPath}");
    expect(
      document.querySelector(".command-form__script-editor-utility"),
    ).toBeNull();
    expect(
      document.querySelector(".command-form__script-editor-flag"),
    ).toBeNull();
  });
});

describe("ArtifactRefInput — right-click menu", () => {
  it("opens a context menu with an insert-artifact submenu parent", () => {
    render(<Harness />);

    act(() => {
      fireEvent.contextMenu(field());
    });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Insert artifact")).toBeTruthy();
  });

  it("lists every artifact in the insert submenu", () => {
    render(<Harness />);

    act(() => {
      fireEvent.contextMenu(field());
    });
    // Hover the parent to open its submenu.
    act(() => {
      fireEvent.mouseEnter(screen.getByText("Insert artifact"));
    });

    expect(screen.getByText("${configPath}")).toBeTruthy();
    expect(screen.getByText("${region}")).toBeTruthy();
  });

  it("choosing an artifact from the menu inserts ${name} at the cursor", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    act(() => {
      fireEvent.contextMenu(field());
    });
    act(() => {
      fireEvent.mouseEnter(screen.getByText("Insert artifact"));
    });
    act(() => {
      fireEvent.click(screen.getByText("${configPath}"));
    });

    expect(onValueChange).toHaveBeenCalledWith("${configPath}");
  });

  it("shows a disabled no-artifacts entry when there are none", () => {
    render(<Harness artifactNames={[]} />);

    act(() => {
      fireEvent.contextMenu(field());
    });

    const menu = screen.getByRole("menu");
    const entry = within(menu).getByText(
      "No artifacts yet. Add an artifact widget first.",
    );
    expect(entry.closest(".context-menu-item")?.className).toContain("disabled");
  });

  it("offers the standard edit actions", () => {
    render(<Harness />);

    act(() => {
      fireEvent.contextMenu(field());
    });

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Cut")).toBeTruthy();
    expect(within(menu).getByText("Copy")).toBeTruthy();
    expect(within(menu).getByText("Paste")).toBeTruthy();
    expect(within(menu).getByText("Select all")).toBeTruthy();
  });

  it("works on the multiline variant too", () => {
    render(<Harness multiline />);

    act(() => {
      fireEvent.contextMenu(field());
    });

    expect(within(screen.getByRole("menu")).getByText("Insert artifact")).toBeTruthy();
  });
});
