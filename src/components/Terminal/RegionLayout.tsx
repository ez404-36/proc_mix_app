import type { ReactElement } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTerminalStore } from "../../stores/terminalStore";
import type { RegionContainer, RegionNode } from "../../types/terminal";
import { TerminalRegion } from "./TerminalRegion";

interface RegionLayoutProps {
  /** The subtree to render (the whole tree at the top level). */
  node: RegionNode;
  /** The active region id (drives which region shows the highlight). */
  activeRegionId: string | null;
  /**
   * This node's location in the tree: the child indices from the root. `[]`
   * at the root. A `SplitHandle` combines this with its child index to tell
   * `setSizes` which container + border a drag targets.
   */
  path?: number[];
}

/**
 * Recursively renders the Terminal panel's region layout tree (`RegionNode`):
 * `region` leaves become `TerminalRegion`s (a tab strip + its tabs), and
 * `row`/`column` containers become flex boxes whose children are separated by
 * draggable `SplitHandle`s. Region sizing is `flex-basis` from each
 * container's `sizes` fractions; xterm's own `FitAddon` + `ResizeObserver`
 * (in `useTerminalSession`) reflow each PTY to its new box, so a resize drag
 * reaches `$COLUMNS`/`$LINES` with no extra wiring.
 */
export function RegionLayout({
  node,
  activeRegionId,
  path = [],
}: RegionLayoutProps): ReactElement {
  const regions = useTerminalStore((s) => s.regions);

  if (node.type === "region") {
    const region = regions[node.regionId];
    // A tree leaf without a backing region is an impossible transient; render
    // nothing rather than crash.
    if (!region) return <></>;
    return (
      <TerminalRegion
        region={region}
        active={node.regionId === activeRegionId}
        visible={true}
      />
    );
  }

  const isRow = node.type === "row";
  return (
    <div className={`terminal-split terminal-split--${node.type}`}>
      {node.children.map((child, i) => (
        <ContainerChild
          key={firstRegionKey(child, i)}
          container={node}
          child={child}
          index={i}
          activeRegionId={activeRegionId}
          path={path}
          isRow={isRow}
        />
      ))}
    </div>
  );
}

/** A child region/subtree plus the resize handle that precedes it (for all
 *  but the first child). */
function ContainerChild({
  container,
  child,
  index,
  activeRegionId,
  path,
  isRow,
}: {
  container: RegionContainer;
  child: RegionNode;
  index: number;
  activeRegionId: string | null;
  path: number[];
  isRow: boolean;
}): ReactElement {
  return (
    <>
      {index > 0 ? (
        <SplitHandle containerPath={path} index={index - 1} isRow={isRow} />
      ) : null}
      <div
        className="terminal-split__pane"
        style={{ flexBasis: `${container.sizes[index] * 100}%` }}
      >
        <RegionLayout
          node={child}
          activeRegionId={activeRegionId}
          path={[...path, index]}
        />
      </div>
    </>
  );
}

interface SplitHandleProps {
  containerPath: number[];
  index: number;
  isRow: boolean;
}

/**
 * Draggable divider between two regions. Copies the pointer-capture drag
 * pattern of `OutputPanel`'s dock-resize handle: capture the pointer, turn
 * each `pointermove`'s px delta (relative to the container's live extent) into
 * a `sizes` fraction, and push it to `terminalStore.setSizes`, which clamps so
 * neither region collapses.
 */
function SplitHandle({ containerPath, index, isRow }: SplitHandleProps): ReactElement {
  const setSizes = useTerminalStore((s) => s.setSizes);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const container = handle.parentElement; // the `.terminal-split` flex box
    if (!container) return;
    const extent = isRow ? container.clientWidth : container.clientHeight;
    if (extent <= 0) return;

    handle.setPointerCapture(event.pointerId);
    let last = isRow ? event.clientX : event.clientY;

    const onMove = (moveEvent: PointerEvent): void => {
      const current = isRow ? moveEvent.clientX : moveEvent.clientY;
      const deltaFraction = (current - last) / extent;
      last = current;
      if (deltaFraction !== 0) setSizes(containerPath, index, deltaFraction);
    };
    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`terminal-split__handle terminal-split__handle--${isRow ? "row" : "column"}`}
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
    />
  );
}

/** Stable-ish key for a child subtree: its first region id (unique across the
 *  panel). Falls back to the index for the unreachable empty subtree. */
function firstRegionKey(node: RegionNode, index: number): string {
  if (node.type === "region") return node.regionId;
  const first = node.children[0];
  return first ? firstRegionKey(first, index) : String(index);
}
