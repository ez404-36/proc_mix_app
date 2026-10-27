import { describe, expect, it } from "vitest";

import { isLocalAssistantBaseUrl } from "./assistantSettings";

describe("isLocalAssistantBaseUrl", () => {
  it("recognizes loopback endpoints", () => {
    expect(isLocalAssistantBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalAssistantBaseUrl("http://localhost:1234/v1/")).toBe(true);
    expect(isLocalAssistantBaseUrl("http://[::1]:8080")).toBe(true);
  });

  it("treats other hosts as remote", () => {
    expect(isLocalAssistantBaseUrl("https://api.example.com/v1")).toBe(false);
    expect(isLocalAssistantBaseUrl("http://localhost.example.com")).toBe(false);
  });
});
