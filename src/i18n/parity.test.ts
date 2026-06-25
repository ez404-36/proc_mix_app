// Key-parity guard for the translation bundles.
//
// Every leaf key present in one locale must exist in the other, so a new
// string added in English is never silently missing in Russian (or vice
// versa). The one legitimate exception is i18next pluralization: English
// uses `key` / `key_one` / `key_other` (or the legacy `key_plural`), while
// Russian uses the full CLDR set `key_one` / `key_few` / `key_many` /
// `key_other`. We normalize those recognized plural suffixes away before
// comparing so the differing-but-correct plural sets don't trip the
// assertion.
//
// The suffix list is intentionally restricted to the i18next/CLDR plural
// category names (plus the legacy `_plural`). It must NOT strip arbitrary
// trailing digits — a key that genuinely ends in a number (e.g. `foo_2fa`
// is excluded by the word boundary, but a real `foo_3`) would otherwise be
// silently collapsed and a missing translation could slip through.

import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import ru from "../locales/ru/translation.json";

type Json = { [key: string]: Json | string };

/** Recognized i18next/CLDR plural suffixes (no arbitrary trailing digits). */
const PLURAL_SUFFIX = /_(?:plural|zero|one|two|few|many|other)$/;

function normalize(key: string): string {
  return key.replace(PLURAL_SUFFIX, "");
}

function collectKeys(node: Json, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      keys.add(normalize(path));
    } else {
      for (const nested of collectKeys(v, path)) {
        keys.add(nested);
      }
    }
  }
  return keys;
}

describe("translation key parity", () => {
  it("en and ru expose the same (plural-normalized) key set", () => {
    const enKeys = collectKeys(en as Json);
    const ruKeys = collectKeys(ru as Json);

    const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k)).sort();
    const missingInEn = [...ruKeys].filter((k) => !enKeys.has(k)).sort();

    expect({ missingInRu, missingInEn }).toEqual({
      missingInRu: [],
      missingInEn: [],
    });
  });
});
