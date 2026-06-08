import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { VariablePrompt } from "./VariablePrompt";
import {
  promptForVariables,
  _resetVariablePromptHandler,
} from "../../utils/variablePrompt";
import "../../i18n";

beforeEach(() => {
  _resetVariablePromptHandler();
});
afterEach(() => {
  _resetVariablePromptHandler();
});

describe("VariablePrompt", () => {
  // The empty-specs short-circuit lives in `promptForVariables` itself,
  // not in the component. This test confirms the contract: no modal is
  // mounted into the DOM, and the resolved map is `{}`.
  it("promptForVariables([]) resolves immediately with {} and does NOT mount the modal", async () => {
    render(<VariablePrompt />);
    const result = await promptForVariables([]);
    expect(result).toEqual({});
    // No dialog rendered.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders one input per spec and resolves null on cancel", async () => {
    render(<VariablePrompt />);
    // Kick off the prompt; do NOT await yet — we need to drive the UI
    // first.
    const promise = promptForVariables([{ name: "a" }, { name: "b" }]);
    // Allow the registered handler's microtask to flush.
    await act(async () => {
      await Promise.resolve();
    });

    // Two text inputs visible, labelled by spec name.
    expect(screen.getByLabelText("a")).toBeDefined();
    expect(screen.getByLabelText("b")).toBeDefined();

    // Click Cancel — the test expects the original Promise to resolve
    // to null. The button's localized label is "Cancel" via i18n.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    const result = await promise;
    expect(result).toBeNull();
  });

  it("collects the typed values on submit and resolves with the map", async () => {
    render(<VariablePrompt />);
    const promise = promptForVariables([{ name: "a" }, { name: "b" }]);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("a"), {
        target: { value: "x" },
      });
      fireEvent.change(screen.getByLabelText("b"), {
        target: { value: "y" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });

    const result = await promise;
    expect(result).toEqual({ a: "x", b: "y" });
  });

  // Sensitive specs are rendered as masked inputs. The HTMLInputElement's
  // `type` attribute is the source of truth; we read it directly off
  // the element rather than relying on visual rendering.
  it("renders a sensitive spec as a password input", async () => {
    render(<VariablePrompt />);
    const promise = promptForVariables([
      { name: "token", sensitive: true },
    ]);
    await act(async () => {
      await Promise.resolve();
    });

    const input = screen.getByLabelText("token") as HTMLInputElement;
    expect(input.type).toBe("password");

    // Tidy up: cancel the modal so the promise resolves and the
    // outer test doesn't leak a pending resolver.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await promise;
  });
});
