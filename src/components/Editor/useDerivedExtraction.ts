import { useEffect, useState } from "react";
import type { ExtractedResult, OutputSchema } from "../../types";
import { previewExtraction } from "../../services/outputExtraction";

/**
 * Derive the structured output-schema extraction of `rawText` under `schema`,
 * debounced. Used by the node modal's input column to show the "Output schema"
 * view computed from whatever raw input is currently displayed — a live run's
 * raw stdout OR a manually-typed sample. Parsing is done by the authoritative
 * Rust `core::extractor` via `previewExtraction` (the TS side never
 * re-implements parser logic — single source of truth).
 *
 * Returns `null` when there is no schema, the raw text is empty, or extraction
 * has not completed yet. A stale-response guard discards results from a prior
 * input once the input changes (StrictMode / fast typing safe).
 */
export function useDerivedExtraction(
  rawText: string,
  schema: OutputSchema | undefined,
): ExtractedResult | null {
  const [result, setResult] = useState<ExtractedResult | null>(null);

  useEffect(() => {
    if (schema === undefined || rawText === "") {
      setResult(null);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      previewExtraction(schema, rawText)
        .then((res) => {
          if (!cancelled) setResult(res);
        })
        .catch(() => {
          // A backend failure leaves no derived schema rather than throwing —
          // the column simply shows raw output only.
          if (!cancelled) setResult(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [rawText, schema]);

  return result;
}
