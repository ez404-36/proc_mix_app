/**
 * Types mirroring the read-only SSH host inventory DTOs from the Rust
 * backend (`core::ssh` + the `list_ssh_hosts` / `check_ssh_host` commands).
 * All field names are camelCase (serde `rename_all = "camelCase"`); the
 * `SshSource` string values are kebab-case (serde `rename_all = "kebab-case"`).
 *
 * Everything here is READ-ONLY: ProcMix parses existing SSH connections from
 * their source of truth (`~/.ssh/config`, …) and never writes them in this
 * iteration. The only mutable state is the last reachability-check result,
 * stored by ProcMix and surfaced as `lastCheck*` on each host.
 */

/**
 * Where a discovered host came from. The string values match
 * `core::ssh::types::SshSource` serde output EXACTLY — pinned by the
 * `wire_spellings_are_pinned` Rust test. Only `'open-ssh-config'` is
 * implemented today; the others are registered stubs (see `SshSourceStatus`).
 */
export type SshSource = 'open-ssh-config' | 'putty' | 'wsl' | 'system-config';

/** Stable `(source, name)` identity of a host across refreshes. */
export interface SshHostId {
  source: SshSource;
  name: string;
}

/**
 * A single SSH host parsed from a source. Connection parameters are optional
 * because a config block need not declare them (ssh resolves the rest).
 */
export interface SshHost {
  id: SshHostId;
  name: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  /**
   * Whether ProcMix may rewrite this block's modelled directives in place.
   * `true` for single-pattern user-config blocks with only modelled
   * directives — INCLUDING wildcard patterns like `*.staging.example.com`.
   * `false` for `Match`/multi-pattern/negation/unknown-directive/`Include`d/
   * system blocks (shown "managed manually").
   */
  editableParams: boolean;
  /**
   * Whether this block's `Host` name may be changed. Same source-level gate
   * as `editableParams`; separate so the UI can warn when renaming a pattern
   * (it reassigns the rule's scope).
   */
  editableName: boolean;
  /** Whether ProcMix may delete this block (false for system/Include). */
  deletable: boolean;
  /** Origin detail for a tooltip (config file path, or `"registry"`). */
  sourceDetail: string;
  /**
   * The block's raw text exactly as in the source file — the `Host` line
   * through the line before the next block. Surfaces EVERY directive,
   * including ones ProcMix doesn't model (`ProxyJump`, `SendEnv`, …); shown
   * verbatim in the view modal. Empty for sources with no textual form.
   */
  rawText: string;
}

/**
 * A host in the inventory view: the parsed connection plus ProcMix's stored
 * metadata. Mirrors the backend `SshHostView` (which flattens `SshHost` and
 * adds the `lastCheck*` fields).
 */
export interface SshHostView extends SshHost {
  /** RFC 3339 timestamp of the last reachability check, or `null`. */
  lastCheckAt: string | null;
  /** `true` reachable, `false` unreachable, `null` never checked. */
  lastCheckOk: boolean | null;
}

/**
 * Per-source availability + implementation status, so the UI can explain why
 * a source contributed no hosts (absent vs not-yet-supported vs read error).
 * Mirrors `core::ssh::registry::SshSourceStatus`.
 */
export interface SshSourceStatus {
  source: SshSource;
  /** The source exists on this machine. */
  available: boolean;
  /** ProcMix has a real reader for this source (vs a registered stub). */
  implemented: boolean;
  /** Read/parse error message when listing failed, else `null`. */
  error: string | null;
}

/** The full inventory payload returned by `list_ssh_hosts`. */
export interface SshInventoryView {
  hosts: SshHostView[];
  /**
   * Wildcard/pattern blocks (`Host *`, `*.example.com`, …) — matching rules,
   * not connections. Shown in a separate read-only "Rules & templates"
   * section; never connectable/checkable. Their `lastCheck*` are always null.
   */
  patterns: SshHostView[];
  sources: SshSourceStatus[];
}

/** Result of a reachability probe (`check_ssh_host`). */
export interface SshCheckResult {
  reachable: boolean;
  message: string;
}

/**
 * A write request describing the desired state of one editable host. Only the
 * modelled fields are expressible, so a draft can never introduce an unknown
 * directive. `null` for an optional field means "this directive should be
 * absent". Mirrors the backend `SshHostDraft`.
 */
export interface SshHostDraft {
  /** The `Host` alias (also identifies the block to rewrite on an edit). */
  name: string;
  /**
   * When renaming, the old alias to remove. `null` for a create or an
   * in-place edit (same alias).
   */
  previousName: string | null;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}
