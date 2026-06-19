// Baseline micro-benchmarks for the JS-parser template helpers.
//
// `inferTsType` recurses over a JSON preview value to build the `data` type
// comment seeded into a new `javascript` parser step. The editor calls it on
// every parser switch with the previous step's preview, so a regression here
// would be felt as input lag in the schema editor. Run with `npm run bench`.

import { bench, describe } from "vitest";
import { inferTsType, jsTemplate } from "./jsParserTemplate";

// A wide table-row preview: one object with `n` string columns (the typical
// `table` parser output shape). The work `inferTsType` does scales with the
// KEY COUNT — every key recurses + emits a field line — so we parametrise on
// width to make a regression in the per-key cost visible.
function wideRow(keys: number): Record<string, string> {
  const row: Record<string, string> = {};
  for (let i = 0; i < keys; i++) row[`col${i}`] = `value${i}`;
  return row;
}
const WIDE_KEY_COUNTS = [10, 50, 200];

// A deeply nested object (stresses the recursive descent).
function deepObject(depth: number): unknown {
  let node: unknown = { leaf: "x", n: 1, ok: true };
  for (let i = 0; i < depth; i++) node = { child: node, label: `lvl${i}` };
  return node;
}
const deep = deepObject(40);

describe("inferTsType", () => {
  bench("primitive", () => {
    inferTsType("hello");
  });

  for (const keys of WIDE_KEY_COUNTS) {
    const row = wideRow(keys);
    bench(`wide object (${keys} keys)`, () => {
      inferTsType(row);
    });
  }

  // `inferTsType` inspects only the FIRST array element to derive the element
  // type — array LENGTH does not affect cost. This case documents that: it is
  // a single wide row wrapped in an array, so it measures the element-shape
  // inference plus the `[]` suffix, NOT a 200-element scan.
  const oneWideRowArray = [wideRow(50)];
  bench("array of one wide object (50 keys)", () => {
    inferTsType(oneWideRowArray);
  });

  bench("deeply nested object (depth 40)", () => {
    inferTsType(deep);
  });
});

describe("jsTemplate", () => {
  const wideLabel = inferTsType([wideRow(50)]);

  bench("single-line label", () => {
    jsTemplate("string[]");
  });

  bench("multi-line label (wide row)", () => {
    jsTemplate(wideLabel);
  });
});
