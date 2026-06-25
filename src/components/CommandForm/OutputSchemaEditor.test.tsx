import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the extraction service so the editor's preview button resolves
// without crossing the real IPC boundary.
const previewSpy = vi.fn();
vi.mock("../../services/outputExtraction", () => ({
  previewExtraction: (...args: unknown[]) => previewSpy(...args),
}));
// Arco Message is unused here, but mock defensively per project convention
// (Arco's Message throws under jsdom/React 19).
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import { OutputSchemaEditor } from "./OutputSchemaEditor";
import type { OutputSchema } from "../../types";
import "../../i18n";
import i18n from "../../i18n";

beforeEach(() => {
  previewSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const t = i18n.t.bind(i18n);

describe("OutputSchemaEditor", () => {
  it("toggling on emits a default raw schema", () => {
    const onChange = vi.fn();
    render(<OutputSchemaEditor value={undefined} onChange={onChange} t={t} />);

    const toggle = screen.getByRole("switch", { name: /parse output/i });
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith({
      pipeline: [{ parser: "raw", fields: [] }],
    });
  });

  it("toggling off clears the schema", () => {
    const onChange = vi.fn();
    const value: OutputSchema = { pipeline: [{ parser: "lines", fields: [] }] };
    render(<OutputSchemaEditor value={value} onChange={onChange} t={t} />);

    const toggle = screen.getByRole("switch", { name: /parse output/i });
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("persists the sample when 'save sample' is enabled, then drops it", () => {
    const onChange = vi.fn();
    const value: OutputSchema = { pipeline: [{ parser: "lines", fields: [] }] };
    const { rerender } = render(
      <OutputSchemaEditor value={value} onChange={onChange} t={t} />,
    );

    // Type a sample, then check the save toggle → schema carries it.
    const sample = screen.getByPlaceholderText(/paste sample stdout/i);
    fireEvent.change(sample, { target: { value: "a\nb\n" } });
    const save = screen.getByRole("checkbox", { name: /save this sample/i });
    fireEvent.click(save);
    expect(onChange).toHaveBeenLastCalledWith({
      pipeline: [{ parser: "lines", fields: [] }],
      sample: "a\nb\n",
    });

    // With the sample persisted, the warning is shown.
    rerender(
      <OutputSchemaEditor
        value={{ pipeline: [{ parser: "lines", fields: [] }], sample: "a\nb\n" }}
        onChange={onChange}
        t={t}
      />,
    );
    expect(screen.getByText(/no sensitive data/i)).toBeTruthy();

    // Unchecking drops the saved sample from the schema.
    fireEvent.click(screen.getByRole("checkbox", { name: /save this sample/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      pipeline: [{ parser: "lines", fields: [] }],
    });
  });

  it("auto-previews when a sample is entered and renders the result", async () => {
    previewSpy.mockResolvedValue({
      fields: { name: "alice" },
      returnValue: "alice",
    });
    const value: OutputSchema = {
      pipeline: [{ parser: "keyValue", delimiter: "=", fields: [] }],
    };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    // Typing a sample triggers the debounced auto-preview — no button.
    const sample = screen.getByPlaceholderText(/paste sample stdout/i);
    fireEvent.change(sample, { target: { value: "name=alice" } });

    await waitFor(() =>
      expect(previewSpy).toHaveBeenCalledWith(value, "name=alice"),
    );
    expect(screen.getAllByText(/"alice"/).length).toBeGreaterThan(0);
  });

  it("auto-previews a saved sample on mount (no user typing)", async () => {
    previewSpy.mockResolvedValue({
      fields: { name: "bob" },
      returnValue: "bob",
    });
    // A schema that already carries a persisted sample — opening the editor
    // must run the preview immediately so the saved result is shown.
    const value: OutputSchema = {
      pipeline: [{ parser: "keyValue", delimiter: "=", fields: [] }],
      sample: "name=bob",
    };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    await waitFor(() =>
      expect(previewSpy).toHaveBeenCalledWith(value, "name=bob"),
    );
    expect(screen.getAllByText(/"bob"/).length).toBeGreaterThan(0);
  });

  it("return value dropdown shows declared fields for table", () => {
    // With declared fields the dropdown offers them as return value options.
    const value: OutputSchema = {
      pipeline: [
        {
          parser: "table",
          hasHeader: true,
          fields: [
            { name: "size", column: "4" },
            { name: "path", column: "8" },
          ],
        },
      ],
    };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    const trigger = screen.getByLabelText("Return value");
    fireEvent.click(trigger);

    const options = screen.getAllByRole("option").map((el) => el.textContent);
    expect(options).toContain("size");
    expect(options).toContain("path");
    // synthetic "rows"/"result" keys must not appear without a preview
    expect(options).not.toContain("rows");
    expect(options).not.toContain("result");
  });

  it("return value dropdown shows only Whole result when no fields declared", () => {
    // Without declared fields and without a preview, only "Whole result" appears.
    const value: OutputSchema = { pipeline: [{ parser: "lines", fields: [] }] };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    const trigger = screen.getByLabelText("Return value");
    fireEvent.click(trigger);

    const options = screen
      .getAllByRole("option")
      .map((el) => el.textContent?.replace(/✓/g, "").trim());
    expect(options).toEqual(["Whole result"]);
  });

  it("auto-preview renders an extraction error inline", async () => {
    previewSpy.mockResolvedValue({
      fields: {},
      returnValue: null,
      error: "invalid JSON output: x",
    });
    const value: OutputSchema = { pipeline: [{ parser: "json", fields: [] }] };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    const sample = screen.getByPlaceholderText(/paste sample stdout/i);
    fireEvent.change(sample, { target: { value: "not json" } });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "invalid JSON output: x",
      ),
    );
  });

  it("a javascript step shows the parse(data) code editor", () => {
    const value: OutputSchema = {
      pipeline: [
        {
          parser: "javascript",
          fields: [],
          code: "function parse(data) { return data; }",
        },
      ],
    };
    render(<OutputSchemaEditor value={value} onChange={vi.fn()} t={t} />);

    // The monospace code textarea is rendered with the step's source...
    const code = screen.getByDisplayValue(
      "function parse(data) { return data; }",
    );
    expect(code).toBeTruthy();
    // ...and the regex pattern / table delimiter inputs are NOT shown for it.
    expect(screen.queryByPlaceholderText("(?P<name>\\w+)")).toBeNull();
  });
});
