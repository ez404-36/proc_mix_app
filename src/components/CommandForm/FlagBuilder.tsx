import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { ParsedArg, ParsedCli, ParsedFlag } from "../../types";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { HelpTooltip } from "../HelpTooltip";
import { makeRowId } from "./formState";
import {
  assembleScript,
  longFlag,
  primaryFlag,
  resolveAlias,
  shortFlag,
} from "./flagBuilderUtils";
import type { ArgRow, FlagRow } from "./flagBuilderUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagLabel(flag: ParsedFlag): string {
  return flag.flags.join(", ");
}

function tokenizeScript(script: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of script.trim()) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function extractUtilityName(script: string): string {
  const tokens = tokenizeScript(script);
  const ESCALATION = new Set(["sudo", "doas", "pkexec"]);
  let start = 0;
  if (tokens.length > 0 && ESCALATION.has(tokens[0]!)) start = 1;
  return tokens[start] ?? "";
}

function prePopulate(
  script: string,
  parsed: ParsedCli,
): { argValues: Record<string, string>; positionalRaw: string; preFlagRows: FlagRow[] } {
  const tokens = tokenizeScript(script);
  const ESCALATION = new Set(["sudo", "doas", "pkexec"]);
  const workTokens = tokens.filter((t) => t.length > 0);
  let start = 0;
  if (workTokens.length > 0 && ESCALATION.has(workTokens[0]!)) start = 1;
  if (workTokens.length > start) start += 1;
  const args = workTokens.slice(start);

  // Build a map from any flag alias → ParsedFlag.
  const flagMap = new Map<string, ParsedFlag>();
  for (const flag of parsed.flags) {
    for (const f of flag.flags) {
      flagMap.set(f, flag);
    }
  }

  const preFlagRows: FlagRow[] = [];
  const usedFlagPrimaries = new Set<string>();
  const positionalValues: string[] = [];

  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    if (token.startsWith("-")) {
      const matchedFlag = flagMap.get(token);
      if (matchedFlag) {
        const primary = primaryFlag(matchedFlag.flags);
        if (!usedFlagPrimaries.has(primary)) {
          usedFlagPrimaries.add(primary);
          let value = "";
          if (matchedFlag.takesValue && i + 1 < args.length) {
            const next = args[i + 1]!;
            if (!next.startsWith("-")) {
              value = next;
              i += 1;
            }
          }
          const eqIdx = token.indexOf("=");
          if (eqIdx !== -1 && matchedFlag.takesValue) {
            value = token.slice(eqIdx + 1);
          }
          // #5: preserve the alias used in the original script.
          const isShortAlias = !token.startsWith("--") && token.length === 2;
          const hasShort = shortFlag(matchedFlag.flags) !== undefined;
          preFlagRows.push({
            rowId: makeRowId(),
            flag: matchedFlag,
            value,
            useShort: isShortAlias && hasShort,
          });
        }
      } else if (!token.startsWith("--") && token.length > 2) {
        // #7: combined short flags like `-czf` or `-hp`.
        const chars = token.slice(1);
        for (const ch of chars) {
          const sf = flagMap.get(`-${ch}`);
          if (sf) {
            const primary = primaryFlag(sf.flags);
            if (!usedFlagPrimaries.has(primary)) {
              usedFlagPrimaries.add(primary);
              let value = "";
              if (sf.takesValue && ch === chars[chars.length - 1]) {
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                  value = next;
                  i += 1;
                }
              }
              // Combined short flags → always use short form.
              preFlagRows.push({ rowId: makeRowId(), flag: sf, value, useShort: true });
            }
          }
        }
      }
    } else {
      positionalValues.push(token);
    }
    i += 1;
  }

  // Named positional args from parser.
  const argValues: Record<string, string> = {};
  parsed.positionalArgs.forEach((arg, idx) => {
    argValues[arg.name] = positionalValues[idx] ?? "";
  });

  // Remaining positional values not consumed by named args → free-text field.
  const namedCount = parsed.positionalArgs.length;
  const positionalRaw = positionalValues.slice(namedCount).join(" ");

  return { argValues, positionalRaw, preFlagRows };
}

const ADD_FLAG_SENTINEL = "__add_flag__";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FlagBuilderProps {
  script: string;
  parsed: ParsedCli;
  onChange: (script: string) => void;
  onDismiss: () => void;
}

export function FlagBuilder({
  script,
  parsed,
  onChange,
  onDismiss,
}: FlagBuilderProps): ReactElement {
  const { t } = useTranslation();

  const utilityName = useMemo(() => extractUtilityName(script), [script]);

  const { argValues: initialArgValues, positionalRaw: initialPositionalRaw, preFlagRows } = useMemo(
    () => prePopulate(script, parsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [argRows, setArgRows] = useState<ArgRow[]>(() =>
    parsed.positionalArgs.map((arg: ParsedArg) => ({
      name: arg.name,
      description: arg.description,
      required: arg.required,
      value: initialArgValues[arg.name] ?? "",
    })),
  );

  // #4: free-text field for positional args not covered by named parser output.
  const [positionalRaw, setPositionalRaw] = useState<string>(initialPositionalRaw);

  const [flagRows, setFlagRows] = useState<FlagRow[]>(preFlagRows);
  const [dropdownValue, setDropdownValue] = useState<string>(ADD_FLAG_SENTINEL);

  const prevParsedRef = useRef<ParsedCli>(parsed);

  useEffect(() => {
    if (prevParsedRef.current === parsed) return;
    prevParsedRef.current = parsed;

    const newPrimaries = new Set<string>(
      parsed.flags.map((f) => primaryFlag(f.flags)),
    );
    const newFlagByPrimary = new Map<string, ParsedFlag>();
    for (const f of parsed.flags) newFlagByPrimary.set(primaryFlag(f.flags), f);

    setFlagRows((prev) =>
      prev
        .filter((row) => newPrimaries.has(primaryFlag(row.flag.flags)))
        .map((row) => ({
          ...row,
          flag: newFlagByPrimary.get(primaryFlag(row.flag.flags)) ?? row.flag,
        })),
    );
    setArgRows(
      parsed.positionalArgs.map((arg: ParsedArg) => ({
        name: arg.name,
        description: arg.description,
        required: arg.required,
        value: "",
      })),
    );
    setPositionalRaw("");
    setDropdownValue(ADD_FLAG_SENTINEL);
  }, [parsed]);

  const utilityNameRef = useRef(utilityName);
  utilityNameRef.current = utilityName;

  useEffect(() => {
    onChange(assembleScript(utilityNameRef.current, argRows, positionalRaw, flagRows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argRows, positionalRaw, flagRows]);

  // #8: full description in dropdown options.
  const flagDropdownOptions = useMemo((): ReadonlyArray<DropdownOption> => {
    const sentinel: DropdownOption = {
      value: ADD_FLAG_SENTINEL,
      label: t("scriptFirstCreator.addFlagPlaceholder"),
      disabled: true,
    };
    const options = parsed.flags.map((flag) => ({
      value: primaryFlag(flag.flags),
      label: flagLabel(flag),
      description: flag.description.length > 0 ? flag.description : undefined,
    }));
    return [sentinel, ...options];
  }, [parsed.flags, t]);

  const flagByPrimary = useMemo(() => {
    const map = new Map<string, ParsedFlag>();
    for (const flag of parsed.flags) {
      map.set(primaryFlag(flag.flags), flag);
    }
    return map;
  }, [parsed.flags]);

  const handleAddFlag = useCallback(
    (primaryStr: string): void => {
      if (primaryStr === ADD_FLAG_SENTINEL) return;
      const flag = flagByPrimary.get(primaryStr);
      if (!flag) return;
      // Default to short form if a short alias exists.
      const hasShort = shortFlag(flag.flags) !== undefined;
      setFlagRows((prev) => [
        ...prev,
        { rowId: makeRowId(), flag, value: "", useShort: hasShort },
      ]);
      setDropdownValue(ADD_FLAG_SENTINEL);
    },
    [flagByPrimary],
  );

  const handleRemoveFlag = useCallback((rowId: string): void => {
    setFlagRows((prev) => prev.filter((r) => r.rowId !== rowId));
  }, []);

  const handleFlagValueChange = useCallback(
    (rowId: string, value: string): void => {
      setFlagRows((prev) =>
        prev.map((r) => (r.rowId === rowId ? { ...r, value } : r)),
      );
    },
    [],
  );

  const handleToggleShort = useCallback((rowId: string): void => {
    setFlagRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, useShort: !r.useShort } : r)),
    );
  }, []);

  const handleArgValueChange = useCallback(
    (name: string, value: string): void => {
      setArgRows((prev) =>
        prev.map((a) => (a.name === name ? { ...a, value } : a)),
      );
    },
    [],
  );

  const hasPositionalArgs = argRows.length > 0;
  const hasFlags = flagRows.length > 0 || parsed.flags.length > 0;

  return (
    <div className="flag-builder">
      <div className="flag-builder__header">
        <span className="flag-builder__title">
          {t("scriptFirstCreator.builderTitle")}
          {utilityName ? (
            <span className="flag-builder__utility-name">: {utilityName}</span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--icon flag-builder__dismiss"
          onClick={onDismiss}
          aria-label={t("scriptFirstCreator.dismissBuilder")}
        >
          ×
        </button>
      </div>

      {/* #4: Named positional args from parser */}
      {hasPositionalArgs ? (
        <div className="flag-builder__section">
          <span className="flag-builder__section-title">
            {t("scriptFirstCreator.requiredArgsSection")}
          </span>
          <ul className="flag-builder__arg-list">
            {argRows.map((arg) => (
              <li key={arg.name} className="flag-builder__arg-row">
                <span className="flag-builder__arg-name">{arg.name}</span>
                <input
                  type="text"
                  className="input flag-builder__arg-value"
                  value={arg.value}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleArgValueChange(arg.name, e.target.value)
                  }
                  placeholder={arg.name}
                  aria-label={arg.name}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Free-text positional args — shown only when the parser found no
          named positional args. When argRows is non-empty it already covers
          positional input; showing both would be redundant and confusing. */}
      {!hasPositionalArgs ? (
        <div className="flag-builder__section">
          <span className="flag-builder__section-title">
            {t("scriptFirstCreator.positionalArgsSection")}
          </span>
          <input
            type="text"
            className="input flag-builder__positional-raw"
            value={positionalRaw}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setPositionalRaw(e.target.value)
            }
            placeholder={t("scriptFirstCreator.positionalArgsPlaceholder")}
            aria-label={t("scriptFirstCreator.positionalArgsSection")}
          />
        </div>
      ) : null}

      {/* Flags section */}
      {hasFlags ? (
        <div className="flag-builder__section">
          <span className="flag-builder__section-title">
            {t("scriptFirstCreator.flagsSection")}
          </span>

          {flagRows.length > 0 ? (
            <ul className="flag-builder__flag-list">
              {flagRows.map((row) => {
                const hasShortAlias = shortFlag(row.flag.flags) !== undefined;
                const hasLongAlias = longFlag(row.flag.flags) !== undefined;
                const canToggle = hasShortAlias && hasLongAlias;
                return (
                  <li key={row.rowId} className="flag-builder__flag-row">
                    <span className="flag-builder__flag-label">
                      {resolveAlias(row)}
                    </span>
                    {/* #8: full description in tooltip */}
                    {row.flag.description.length > 0 ? (
                      <HelpTooltip
                        id={`flag-builder-help-${row.rowId}`}
                        buttonLabel={row.flag.description}
                        body={row.flag.description}
                      />
                    ) : null}
                    {row.flag.takesValue ? (
                      <input
                        type="text"
                        className="input flag-builder__flag-value"
                        value={row.value}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          handleFlagValueChange(row.rowId, e.target.value)
                        }
                        placeholder={
                          row.flag.valueHint.length > 0
                            ? row.flag.valueHint
                            : t("scriptFirstCreator.flagValuePlaceholder")
                        }
                        aria-label={flagLabel(row.flag)}
                      />
                    ) : null}
                    {/* #6: Краткий вариант checkbox */}
                    {canToggle ? (
                      <label className="flag-builder__flag-short-toggle">
                        <input
                          type="checkbox"
                          checked={row.useShort}
                          onChange={() => handleToggleShort(row.rowId)}
                        />
                        <span>{t("scriptFirstCreator.useShortFlag")}</span>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon flag-builder__flag-remove"
                      onClick={() => handleRemoveFlag(row.rowId)}
                      aria-label={t("scriptFirstCreator.removeFlag", {
                        flag: flagLabel(row.flag),
                        defaultValue: `Remove ${flagLabel(row.flag)}`,
                      })}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {parsed.flags.length > 0 ? (
            <div className="flag-builder__add-flag">
              <Dropdown
                value={dropdownValue}
                options={flagDropdownOptions}
                onChange={handleAddFlag}
                ariaLabel={t("scriptFirstCreator.addFlagPlaceholder")}
                searchable
                searchPlaceholder={t("scriptFirstCreator.flagSearchPlaceholder")}
              />
            </div>
          ) : null}

          {parsed.flags.length === 0 && flagRows.length === 0 ? (
            <p className="flag-builder__no-flags">
              {t("scriptFirstCreator.noFlagsFound")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
