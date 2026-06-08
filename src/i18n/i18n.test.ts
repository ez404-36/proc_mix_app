import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LANGUAGES,
  detectInitialLanguage,
  isSupportedLanguage,
} from "./index";

/** Override navigator.language for a single test. */
function setNavigatorLanguage(value: string | undefined): void {
  Object.defineProperty(navigator, "language", {
    value,
    configurable: true,
  });
}

const ORIGINAL_LANG = navigator.language;

afterEach(() => {
  setNavigatorLanguage(ORIGINAL_LANG);
});

describe("i18n constants", () => {
  it("should expose 'en' and 'ru' as the supported languages", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "ru"]);
  });

  it("should default to English", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
  });

  it("should map every supported language to a native display name", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_NATIVE_NAMES[lang]).toBeTypeOf("string");
      expect(LANGUAGE_NATIVE_NAMES[lang].length).toBeGreaterThan(0);
    }
  });
});

describe("isSupportedLanguage", () => {
  it("should return true for each supported language code", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(lang)).toBe(true);
    }
  });

  it("should return false for unsupported language codes", () => {
    expect(isSupportedLanguage("fr")).toBe(false);
    expect(isSupportedLanguage("de")).toBe(false);
    expect(isSupportedLanguage("")).toBe(false);
    expect(isSupportedLanguage("EN")).toBe(false); // case-sensitive
  });
});

describe("detectInitialLanguage", () => {
  it("should return the navigator short language when supported", () => {
    setNavigatorLanguage("en-US");
    expect(detectInitialLanguage()).toBe("en");
    setNavigatorLanguage("ru-RU");
    expect(detectInitialLanguage()).toBe("ru");
  });

  it("should accept a bare short language without region", () => {
    setNavigatorLanguage("ru");
    expect(detectInitialLanguage()).toBe("ru");
  });

  it("should fall back to DEFAULT_LANGUAGE for unsupported codes", () => {
    setNavigatorLanguage("fr-FR");
    expect(detectInitialLanguage()).toBe(DEFAULT_LANGUAGE);
  });

  it("should fall back to DEFAULT_LANGUAGE when navigator.language is empty or missing", () => {
    setNavigatorLanguage("");
    expect(detectInitialLanguage()).toBe(DEFAULT_LANGUAGE);
    setNavigatorLanguage(undefined);
    expect(detectInitialLanguage()).toBe(DEFAULT_LANGUAGE);
  });

  it("should lowercase the navigator value before matching", () => {
    setNavigatorLanguage("EN-US");
    expect(detectInitialLanguage()).toBe("en");
  });

  it("should fall back to DEFAULT_LANGUAGE when navigator is undefined", () => {
    const originalNavigator = globalThis.navigator;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).navigator;
    try {
      expect(detectInitialLanguage()).toBe(DEFAULT_LANGUAGE);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    }
  });
});
