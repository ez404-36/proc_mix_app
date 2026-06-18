// Baseline micro-benchmarks for the JS-parser template helpers.
//
// `inferTsType` recurses over a JSON preview value to build the `data` type
// comment seeded into a new `javascript` parser step. The editor calls it on
// every parser switch with the previous step's preview, so a regression here
// would be felt as input lag in the schema editor. Run with `npm run bench`.

import { bench, describe } from "vitest";
import { inferTsType, jsTemplate } from "./jsParserTemplate";

// A wide table-row preview: one object with many string columns (the typical
// `table` parser output shape).
const wideRow: Record<string, string> = {};
for (let i = 0; i < 50; i++) wideRow[`col${i}`] = `value${i}`;

// An array of wide rows (the common "table → array of objects" preview).
const wideRowArray = Array.from({ length: 200 }, () => ({ ...wideRow }));

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

  bench("wide object (50 keys)", () => {
    inferTsType(wideRow);
  });

  bench("array of wide objects (200×50)", () => {
    // Only the first element drives the element type, but this mirrors the
    // real call shape (the editor passes the whole preview array).
    inferTsType(wideRowArray);
  });

  bench("deeply nested object (depth 40)", () => {
    inferTsType(deep);
  });
});

describe("jsTemplate", () => {
  const wideLabel = inferTsType(wideRowArray);

  bench("single-line label", () => {
    jsTemplate("string[]");
  });

  bench("multi-line label (wide row)", () => {
    jsTemplate(wideLabel);
  });
});
