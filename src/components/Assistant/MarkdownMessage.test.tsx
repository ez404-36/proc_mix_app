import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders common markdown structure", () => {
    render(
      <MarkdownMessage
        text={[
          "## How it works",
          "",
          "Run `kill-port` with **care**:",
          "",
          "- finds the listener",
          "- sends SIGTERM",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByText("care")).toBeTruthy();
    expect(screen.getByText("kill-port")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not render raw HTML", () => {
    const { container } = render(
      <MarkdownMessage text={'Before <img src="x" onerror="alert(1)"> after'} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img/)).toBeTruthy();
  });

  it("allows only HTTP(S) markdown links", () => {
    const { container } = render(
      <MarkdownMessage
        text={["[Docs](https://example.com)", "[Bad](javascript:alert(1))"].join(
          "\n",
        )}
      />,
    );

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com");
    expect(screen.getByText("Bad")).toBeTruthy();
  });

  it("renders GitHub-flavored tables", () => {
    render(
      <MarkdownMessage
        text={"| Step | Value |\n| --- | --- |\n| Find | PID |\n| Stop | TERM |"}
      />,
    );

    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Step" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "PID" })).toBeTruthy();
  });
});
