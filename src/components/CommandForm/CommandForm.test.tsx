import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

// Mocks for executor / IPC / Tauri so the component can render without a
// real backend. We don't exercise the live-run path in these tests —
// they target the Variables section and its submit payload.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../utils/executor", () => ({
  runCommand: vi.fn(),
  cancelExecution: vi.fn(),
  subscribeExecutionEvents: vi.fn(() => () => {}),
  awaitBridgeReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("../../utils/adminPassword", () => ({
  hasAdminPassword: vi.fn().mockResolvedValue(false),
  isAdminPasswordRequiredError: vi.fn().mockReturnValue(false),
  setAdminPassword: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../utils/adminPasswordPrompt", () => ({
  promptForAdminPassword: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../utils/platform", () => ({
  getCachedPlatform: vi.fn().mockReturnValue("linux"),
}));
vi.mock("../../utils/shells", () => ({
  getCachedAvailableShells: vi.fn().mockReturnValue(["bash"]),
}));

// Spy on the history-aware `createCommand` action so we can assert
// the submitted payload at the boundary CommandForm actually crosses
// (services/commandActions). Mocking at this layer also means the
// real history-repository never runs — no IPC, no toasts.
const addCommandSpy = vi.fn();
const updateCommandSpy = vi.fn();
vi.mock("../../services/commandActions", () => ({
  createCommand: (...args: unknown[]) => addCommandSpy(...args),
  updateCommand: (...args: unknown[]) => updateCommandSpy(...args),
}));

import { CommandForm } from "./CommandForm";
import { ContextMenuProvider } from "../ContextMenu";
import "../../i18n";

beforeEach(() => {
  addCommandSpy.mockReset();
  updateCommandSpy.mockReset();
  // The component reads `.id` / `.name` off the returned Command in
  // some flows (none of the assertions below depend on the return
  // value, but a structured stub keeps history-recording from
  // crashing if a code path is added later).
  addCommandSpy.mockReturnValue({
    id: "stub-id",
    name: "stub-name",
    script: "",
    tags: [],
    favorite: false,
    runAsAdmin: false,
    runCount: 0,
    createdAt: "2026-05-28T00:00:00Z",
    updatedAt: "2026-05-28T00:00:00Z",
  });
  updateCommandSpy.mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function renderForm(): Promise<{
  onClose: () => void;
  onDirtyChange: ReturnType<typeof vi.fn>;
}> {
  const onClose = vi.fn();
  const onDirtyChange = vi.fn();
  // CommandForm transitively uses `useContextMenu` (via ScriptEditor's
  // right-click "Insert variable" menu). The hook throws when not
  // wrapped in a provider, so the test render mounts one.
  render(
    <ContextMenuProvider>
      <CommandForm
        command={null}
        mode="create"
        onClose={onClose}
        onDirtyChange={onDirtyChange}
      />
    </ContextMenuProvider>,
  );
  // The component fires an async `hasAdminPassword()` query inside an
  // effect on mount; flush it so the late `setState` doesn't trigger
  // an "update not wrapped in act" warning inside test assertions.
  await act(async () => {
    await Promise.resolve();
  });
  return { onClose, onDirtyChange };
}

/**
 * Fill the always-required scalar fields so submit isn't blocked by
 * the name/script validators. We focus the tests on the variables
 * section, not on retesting the existing field-level validation.
 */
// The form is split into tabs (Main / Script / Output). Name lives on
// Main (active by default); Script + Variables live on the Script tab.
// Inactive panels are `hidden` (out of the a11y tree), so tests must
// switch to the Script tab before touching the script/variables fields.
function goToScriptTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: /Script/ }));
}

function goToMainTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: /Main/ }));
}

function fillRequiredFields(): void {
  fireEvent.change(screen.getByPlaceholderText(/Restart dev server/i), {
    target: { value: "Test cmd" },
  });
  goToScriptTab();
  const scriptArea = screen.getByPlaceholderText(/Enter the script to run/i);
  fireEvent.change(scriptArea, { target: { value: "echo hi" } });
  // Return to Main so callers that go on to interact with Main-tab fields
  // (tags, category) find them visible. Tests needing the Script tab
  // re-activate it explicitly (e.g. via clickAddVariable / goToScriptTab).
  goToMainTab();
}

function clickAddVariable(): void {
  // Variables are on the Script tab; make sure it is active.
  goToScriptTab();
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
}

function getVariableRows(): HTMLLIElement[] {
  const list = document.querySelector(".command-form__variables");
  if (!list) return [];
  return Array.from(list.querySelectorAll("li"));
}

function clickSave(): void {
  // The footer save button is labelled "Save" in both create and edit mode
  // (commandForm.actions.save).
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("CommandForm — Variables section", () => {
  it("submits a row with promptAtRuntime unchecked and an explicit default", async () => {
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    // Fill the name. The default placeholder for the row is "name".
    const nameInput = within(row).getByPlaceholderText("name");
    fireEvent.change(nameInput, { target: { value: "foo" } });

    // Uncheck "Prompt at runtime" — this is the ONLY way to surface
    // the default-value input.
    const promptCheckbox = within(row).getByLabelText("Prompt at runtime");
    fireEvent.click(promptCheckbox);

    const defaultInput = within(row).getByPlaceholderText("default value");
    fireEvent.change(defaultInput, { target: { value: "bar" } });

    clickSave();

    expect(addCommandSpy).toHaveBeenCalledTimes(1);
    const payload = addCommandSpy.mock.calls[0]?.[0] as {
      variables?: unknown;
    };
    expect(payload.variables).toEqual([
      { name: "foo", defaultValue: "bar", sensitive: false },
    ]);
  });

  it("omits defaultValue from the payload when promptAtRuntime is checked", async () => {
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    fireEvent.change(within(row).getByPlaceholderText("name"), {
      target: { value: "x" },
    });
    // Leave promptAtRuntime checked (default).

    clickSave();

    expect(addCommandSpy).toHaveBeenCalledTimes(1);
    const payload = addCommandSpy.mock.calls[0]?.[0] as {
      variables?: unknown;
    };
    expect(payload.variables).toEqual([{ name: "x", sensitive: false }]);
    const spec = (payload.variables as Array<Record<string, unknown>>)[0];
    expect(spec).toBeDefined();
    if (!spec) return;
    expect("defaultValue" in spec).toBe(false);
  });

  it("preserves an empty string as a valid defaultValue", async () => {
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    fireEvent.change(within(row).getByPlaceholderText("name"), {
      target: { value: "x" },
    });
    // Uncheck promptAtRuntime; leave the default empty.
    fireEvent.click(within(row).getByLabelText("Prompt at runtime"));

    clickSave();

    expect(addCommandSpy).toHaveBeenCalledTimes(1);
    const payload = addCommandSpy.mock.calls[0]?.[0] as {
      variables?: unknown;
    };
    expect(payload.variables).toEqual([
      { name: "x", defaultValue: "", sensitive: false },
    ]);
  });

  it("shows an invalid-name error and blocks submit", async () => {
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    fireEvent.change(within(row).getByPlaceholderText("name"), {
      target: { value: "1abc" },
    });

    // Inline error must be visible.
    expect(
      within(row).getByText(
        "Use letters, digits, and underscores; must not start with a digit.",
      ),
    ).toBeDefined();

    // Submit must be a no-op.
    clickSave();
    expect(addCommandSpy).not.toHaveBeenCalled();

    // Save stays clickable but is marked invalid via `aria-disabled`
    // (form-level aggregation — hasErrors). It is intentionally NOT the
    // native `disabled` attribute, so clicking it can reveal the errors.
    const saveBtn = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("does NOT show the invalid-name error until the user touches the name field", async () => {
    // Regression: the invalid-name error must only appear after the field
    // has been edited/blurred, or after Save was clicked.
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    // Freshly added: no visible error.
    expect(
      within(row).queryByText(
        "Use letters, digits, and underscores; must not start with a digit.",
      ),
    ).toBeNull();

    // Blur the name input — the touched flag flips and the error
    // surfaces because the (still-empty) name fails the regex.
    const nameInput = within(row).getByPlaceholderText("name");
    fireEvent.blur(nameInput);
    expect(
      within(row).getByText(
        "Use letters, digits, and underscores; must not start with a digit.",
      ),
    ).toBeDefined();
  });

  it("marks Save invalid (aria-disabled) while an untouched row is still invalid", async () => {
    // The Save button is gated by the form-level `hasErrors`
    // aggregation, NOT by per-row visibility. So even though the
    // invalid-name error is hidden on a freshly-added untouched
    // row, submission is still blocked. This guarantees the user
    // can never sneak past a regex-invalid name by simply not
    // touching the field.
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    // Error is hidden (untouched row).
    expect(
      within(row).queryByText(
        "Use letters, digits, and underscores; must not start with a digit.",
      ),
    ).toBeNull();

    // But Save is marked invalid via aria-disabled (still clickable).
    const saveBtn = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders the remove button as an icon-only button with an aria-label", async () => {
    // The button shows just the trash SVG; the accessible name comes
    // from the aria-label / title (both bound to the same translation).
    await renderForm();
    fillRequiredFields();
    clickAddVariable();

    const row = getVariableRows()[0];
    expect(row).toBeDefined();
    if (!row) return;

    const removeBtn = within(row).getByRole("button", { name: "Remove" });
    expect(removeBtn).toBeDefined();
    // The button text content is empty (icon only); the accessible
    // name comes from aria-label, not from a visible label.
    expect(removeBtn.textContent ?? "").toBe("");
    // SVG present.
    expect(removeBtn.querySelector("svg")).not.toBeNull();
  });

  it("shows a duplicate-name error on the second occurrence and blocks submit", async () => {
    await renderForm();
    fillRequiredFields();
    clickAddVariable();
    clickAddVariable();

    const rows = getVariableRows();
    expect(rows.length).toBe(2);
    const [first, second] = rows;
    if (!first || !second) return;

    fireEvent.change(within(first).getByPlaceholderText("name"), {
      target: { value: "x" },
    });
    fireEvent.change(within(second).getByPlaceholderText("name"), {
      target: { value: "x" },
    });

    // First row stays clean (canonical occurrence).
    expect(
      within(first).queryByText("Duplicate variable name."),
    ).toBeNull();
    // Second row carries the duplicate error.
    expect(
      within(second).getByText("Duplicate variable name."),
    ).toBeDefined();

    // Submit blocked.
    clickSave();
    expect(addCommandSpy).not.toHaveBeenCalled();
  });
});

describe("CommandForm — Tags & Category", () => {
  function getTagInput(): HTMLInputElement {
    return screen.getByPlaceholderText(
      "Add a tag and press Enter",
    ) as HTMLInputElement;
  }

  it("adds tag chips (Enter) and submits them, deduped, on the command", async () => {
    await renderForm();
    fillRequiredFields();

    const tagInput = getTagInput();
    fireEvent.change(tagInput, { target: { value: "ci" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(tagInput, { target: { value: "deploy" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    // Duplicate (case-insensitive) should be ignored.
    fireEvent.change(tagInput, { target: { value: "CI" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    clickSave();

    expect(addCommandSpy).toHaveBeenCalledTimes(1);
    const payload = addCommandSpy.mock.calls[0]?.[0] as { tags?: unknown };
    expect(payload.tags).toEqual(["ci", "deploy"]);
  });

  it("removes the last chip on Backspace when the input is empty", async () => {
    await renderForm();
    fillRequiredFields();

    const tagInput = getTagInput();
    fireEvent.change(tagInput, { target: { value: "alpha" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(tagInput, { target: { value: "beta" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    // Two chips present.
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();

    // Backspace on empty input removes the last chip ("beta").
    fireEvent.keyDown(tagInput, { key: "Backspace" });

    clickSave();
    const payload = addCommandSpy.mock.calls[0]?.[0] as { tags?: unknown };
    expect(payload.tags).toEqual(["alpha"]);
  });

  it("sets categoryId via the new-category flow", async () => {
    await renderForm();
    fillRequiredFields();

    // The Category field is a custom Dropdown (on the Main tab, active
    // after fillRequiredFields). Open it and pick the "New category…"
    // action, which swaps in an inline text input.
    const categoryTrigger = screen.getByRole("button", { name: "Category" });
    fireEvent.click(categoryTrigger);
    fireEvent.click(screen.getByText("New category…"));

    const newCategoryInput = screen.getByPlaceholderText(
      "Category name",
    ) as HTMLInputElement;
    fireEvent.change(newCategoryInput, { target: { value: "Build" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    clickSave();
    const payload = addCommandSpy.mock.calls[0]?.[0] as {
      categoryId?: unknown;
    };
    expect(payload.categoryId).toBe("Build");
  });

  it("omits categoryId when the category field is left blank", async () => {
    await renderForm();
    fillRequiredFields();

    clickSave();
    const payload = addCommandSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("categoryId" in payload).toBe(false);
  });

  it("defaults to an empty tags array when no tags are entered", async () => {
    await renderForm();
    fillRequiredFields();

    clickSave();
    const payload = addCommandSpy.mock.calls[0]?.[0] as { tags?: unknown };
    expect(payload.tags).toEqual([]);
  });
});

describe("CommandForm — tabs", () => {
  it("Save with an empty Script jumps to the Script tab and shows the error", async () => {
    await renderForm();
    // Fill only the name (Main tab); leave the script empty. Stay on Main.
    fireEvent.change(screen.getByPlaceholderText(/Restart dev server/i), {
      target: { value: "Test cmd" },
    });

    // Sanity: we're on Main, the script field is not in the a11y tree.
    expect(
      screen.getByRole("tab", { name: /Main/ }).getAttribute("aria-selected"),
    ).toBe("true");

    clickSave();

    // Save should switch to the Script tab (first tab with an error) and
    // the script validation error becomes visible there.
    expect(
      screen.getByRole("tab", { name: /Script/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(addCommandSpy).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Enter the script to run/i)).toBeTruthy();
  });
});

describe("CommandForm — unsaved-changes guard", () => {
  it("clears the dirty flag on a successful save so navigation isn't blocked", async () => {
    // Regression: a save must report the form as clean (onDirtyChange(false))
    // before it closes, so the leave-guard doesn't block navigation.
    const { onClose, onDirtyChange } = await renderForm();
    fillRequiredFields();

    // Editing made the form dirty at least once.
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    onDirtyChange.mockClear();
    clickSave();

    expect(addCommandSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // The last dirty signal emitted as part of the save must be `false`.
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    const calls = onDirtyChange.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toBe(false);
  });
});
