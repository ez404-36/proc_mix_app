import { describe, expect, it } from "vitest";
import { SCHEDULE_SECRET_REF, isScheduleSecretRef } from "./scheduleSecrets";

describe("scheduleSecrets", () => {
  it("the sentinel is wrapped in U+0001 control chars", () => {
    expect(SCHEDULE_SECRET_REF).toBe("\u0001procmix:keychain-secret\u0001");
    expect(SCHEDULE_SECRET_REF.charCodeAt(0)).toBe(0x01);
    expect(SCHEDULE_SECRET_REF.charCodeAt(SCHEDULE_SECRET_REF.length - 1)).toBe(
      0x01,
    );
  });

  it("recognises the exact sentinel", () => {
    expect(isScheduleSecretRef(SCHEDULE_SECRET_REF)).toBe(true);
  });

  it("does not match the marker text without the control chars", () => {
    expect(isScheduleSecretRef("procmix:keychain-secret")).toBe(false);
  });

  it("does not match empty or arbitrary values", () => {
    expect(isScheduleSecretRef("")).toBe(false);
    expect(isScheduleSecretRef("secret")).toBe(false);
    expect(isScheduleSecretRef(`${SCHEDULE_SECRET_REF} `)).toBe(false);
  });
});
