// Key-parity guard for the translation bundles.
//
// Every leaf key present in one locale must exist in the other, so a new
// string added in English is never silently missing in Russian (or vice
// versa). The one legitimate exception is i18next pluralization: English
// uses `key` / `key_plural`, while Russian uses the CLDR forms
// `key_0` / `key_1` / `key_2`. We normalize those plural suffixes away
// before comparing so the differing-but-correct plural sets don't trip
// the assertion.

import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import ru from "../locales/ru/translation.json";

type Json = { [key: string]: Json | string };

/** i18next plural suffixes for the languages we ship. */
const PLURAL_SUFFIX = /_(?:plural|zero|one|two|few|many|other|\d+)$/;

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
