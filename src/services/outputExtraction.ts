// Typed wrapper around the `preview_extraction` Rust IPC command.
//
// The OutputSchemaEditor calls this to preview how an output schema would
// parse a sample of stdout, without running any command. Parsing is done
// by the authoritative Rust `core::extractor`; the TS side never
// re-implements the parser logic (a single source of truth avoids the
// schema/parse drift the design explicitly guards against).

import { invoke } from "@tauri-apps/api/core";
import type { ExtractedResult, OutputSchema } from "../types";

/**
 * Preview the extraction of `sampleStdout` under `schema`.
 *
 * Resolves to an {@link ExtractedResult}: on success `error` is absent and
 * `fields` / `returnValue` are populated; on a schema/parse failure
 * `error` carries the message and the other fields are empty. `invoke`
 * itself rejects only on a genuine internal backend error — callers
 * should still catch at their boundary.
 *
 * @param schema the output schema being edited.
 * @param sampleStdout the sample text to parse (e.g. pasted command output).
 */
export async function previewExtraction(
  schema: OutputSchema,
  sampleStdout: string,
): Promise<ExtractedResult> {
  return invoke<ExtractedResult>("preview_extraction", {
    schema,
    sampleStdout,
  });
}
