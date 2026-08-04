import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import "../../i18n";
import type { NewMiniAppInput } from "../../stores/miniappStore";
import { MiniAppTemplateDialog } from "./MiniAppTemplateDialog";

function template(overrides: Partial<NewMiniAppInput> = {}): NewMiniAppInput {
  return {
    name: "System Info",
    description: "Live uptime and CPU load with disk, memory, and system-details buttons",
    widgets: [],
    tags: [],
    favorite: false,
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<Parameters<typeof MiniAppTemplateDialog>[0]> = {},
): { onSelect: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    render(
      <MiniAppTemplateDialog
        open
        templates={[
          template(),
          template({ name: "OpenVPN3 Control Panel", description: "VPN" }),
        ]}
        onSelect={onSelect}
        onCancel={onCancel}
        {...overrides}
      />,
    );
  });
  return { onSelect, onCancel };
}

describe("MiniAppTemplateDialog", () => {
  it("renders nothing when open is false", () => {
    act(() => {
      render(
        <MiniAppTemplateDialog
          open={false}
          templates={[template()]}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a name + description row for every template", () => {
    renderDialog();
    expect(screen.getByText("System Info")).toBeTruthy();
    expect(
      screen.getByText("Live uptime and CPU load with disk, memory, and system-details buttons"),
    ).toBeTruthy();
    expect(screen.getByText("OpenVPN3 Control Panel")).toBeTruthy();
    expect(screen.getByText("VPN")).toBeTruthy();
  });

  it("calls onSelect with the clicked template", () => {
    const { onSelect, onCancel } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByText("OpenVPN3 Control Panel"));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({
      name: "OpenVPN3 Control Panel",
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const { onCancel } = renderDialog();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the backdrop is clicked", () => {
    const { onCancel, onSelect } = renderDialog();
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    act(() => {
      if (backdrop) fireEvent.click(backdrop);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("resolves nameKey/descriptionKey translations over literal fields", () => {
    const onSelect = vi.fn();
    act(() => {
      render(
        <MiniAppTemplateDialog
          open
          templates={[
            template({
              name: "raw literal",
              nameKey: "miniapps.seeds.systemInfo.name",
              descriptionKey: "miniapps.seeds.systemInfo.description",
            }),
          ]}
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      );
    });
    expect(screen.getByText("System Info")).toBeTruthy();
    expect(
      screen.getByText("Live uptime and CPU load with disk, memory, and system-details buttons"),
    ).toBeTruthy();
    expect(screen.queryByText("raw literal")).toBeNull();
  });
});
