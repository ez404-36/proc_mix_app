import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type {
  TerminalCompletionCandidate,
  TerminalCompletionRequest,
  TerminalCompletionResponse,
} from "../../../types/terminal";

import {
  createCompletionController,
  longestCommonPrefix,
  promptPrefixLength,
  rawInsertion,
} from "./completionController";

/** Mutable fake of the single xterm line the controller reads. */
interface MockBuffer {
  line: string;
  cursorX: number;
  type: "normal" | "alternate";
  /** Simulated row width for the untrimmed `translateToString(false)` view. */
  padWidth?: number;
}

function makeTerm(buffer: MockBuffer): Terminal {
  return {
    buffer: {
      active: {
        get type() {
          return buffer.type;
        },
        cursorY: 0,
        get cursorX() {
          return buffer.cursorX;
        },
        getLine: () => ({
          // Mirror REAL xterm semantics: trimRight=true strips trailing
          // whitespace; false pads the row out to full width. The padWidth
          // field lets tests prove the controller is padding-agnostic.
          translateToString: (trimRight: boolean) =>
            trimRight
              ? buffer.line.trimEnd()
              : buffer.line.padEnd(buffer.padWidth ?? buffer.line.length, " "),
        }),
      },
    },
  } as unknown as Terminal;
}

type CompleteFn = (
  request: TerminalCompletionRequest,
) => Promise<TerminalCompletionResponse>;

/** Shared multi-candidate fixture for cycle/popup tests. */
const DOCKER_CANDIDATES: TerminalCompletionCandidate[] = [
  { name: "docker", isDir: false },
  { name: "docker-compose", isDir: false },
];

/** A FRESH vi.fn per test (each asserts its own call count). */
const dockerComplete = (): CompleteFn =>
  vi.fn(async () => ({ candidates: DOCKER_CANDIDATES }));

function makeDeps(complete: CompleteFn) {
  const writes: string[] = [];
  const popupStates: (unknown | null)[] = [];
  return {
    writes,
    popupStates,
    deps: {
      sessionId: "s1",
      write: (data: string): void => {
        writes.push(data);
      },
      complete,
      describeSession: vi.fn(async () => ({ cwd: "/home/u" })),
      homeDir: vi.fn(async () => "/home/u"),
      onPopupStateChange: (state: unknown | null) => popupStates.push(state),
    },
  };
}

function tabEvent(shift = false): KeyboardEvent {
  return {
    type: "keydown",
    key: "Tab",
    code: "Tab",
    shiftKey: shift,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Simulate the shell echoing the controller's PTY write: `prefix` is the
 *  prompt + typed word, `inserted` is what now sits at end-of-line. */
function echo(buffer: MockBuffer, prefix: string, inserted: string): void {
  buffer.line = prefix + inserted;
  buffer.cursorX = buffer.line.length;
}

describe("createCompletionController", () => {
  let buffer: MockBuffer;

  beforeEach(() => {
    buffer = { line: "", cursorX: 0, type: "normal", padWidth: 120 };
  });

  it("strips the prompt and completes a single command match with a space", async () => {
    buffer.line = "egor@host:~$ gre";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "grep", isDir: false }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    expect(controller.handleKeyEvent(tabEvent())).toBe(false);
    await flush();

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "command", prefix: "gre", baseDir: null }),
    );
    // Erase the typed word (3 chars) and insert the full match + space.
    expect(writes).toEqual(["\x7F\x7F\x7Fgrep "]);
  });

  it("completes to the LCP for multiple candidates, then cycles and wraps", async () => {
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toEqual(["\x7F\x7F\x7Fdocker"]); // LCP, no suffix
    echo(buffer, "host$ ", "docker");

    controller.handleKeyEvent(tabEvent()); // cycle → docker + space
    await flush();
    expect(writes[1]).toBe("\x7F".repeat(6) + "docker ");
    echo(buffer, "host$ ", "docker ");

    controller.handleKeyEvent(tabEvent()); // cycle → docker-compose
    await flush();
    // A FULLY inserted candidate also carries the trailing space.
    expect(writes[2]).toBe("\x7F".repeat(7) + "docker-compose ");
    echo(buffer, "host$ ", "docker-compose ");

    controller.handleKeyEvent(tabEvent()); // wrap → original word
    await flush();
    expect(writes[3]).toBe("\x7F".repeat(15) + "doc");
  });

  it("starts a Shift+Tab cycle at the last candidate and wraps backwards", async () => {
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent(true));
    await flush();
    expect(writes[0]).toBe("\x7F".repeat(3) + "docker-compose ");
    echo(buffer, "host$ ", "docker-compose ");

    controller.handleKeyEvent(tabEvent(true)); // backwards → docker
    await flush();
    expect(writes[1]).toBe("\x7F".repeat(15) + "docker "); // erase "docker-compose "
    echo(buffer, "host$ ", "docker ");

    controller.handleKeyEvent(tabEvent(true)); // backwards from the first → original word
    await flush();
    expect(writes[2]).toBe("\x7F".repeat(7) + "doc");
    echo(buffer, "host$ ", "doc");

    controller.handleKeyEvent(tabEvent(true)); // further backwards → wrap to last
    await flush();
    expect(writes[3]).toBe("\x7F".repeat(3) + "docker-compose ");
  });

  it("streams popup state while cycling and clears it on input", async () => {
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { popupStates, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(popupStates[0]).toEqual({
      candidates: DOCKER_CANDIDATES,
      index: -1,
    });

    echo(buffer, "host$ ", "docker");
    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(popupStates[1]).toEqual({
      candidates: expect.any(Array),
      index: 0,
    });

    controller.notifyInput("x");
    expect(popupStates[2]).toBeNull();
  });

  it("does not open the popup for a single candidate", async () => {
    buffer.line = "host$ gre";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "grep", isDir: false }],
    }));
    const { popupStates, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(popupStates).toEqual([null]);
  });

  it("accepts a popup click by index and hides the list", async () => {
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { writes, popupStates, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    echo(buffer, "host$ ", "docker");

    controller.accept(1); // click "docker-compose"
    expect(writes[1]).toBe("\x7F".repeat(6) + "docker-compose ");
    expect(popupStates[1]).toBeNull(); // hidden after accept

    // The cycle stays armed: a Tab continues stepping from the accepted
    // index (1 → 2 wraps to the original word).
    echo(buffer, "host$ ", "docker-compose ");
    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes[2]).toBe("\x7F".repeat(15) + "doc");
  });

  it("dismisses the popup on Escape without erasing the word", async () => {
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { writes, popupStates, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    echo(buffer, "host$ ", "docker");

    const esc = {
      type: "keydown",
      key: "Escape",
      preventDefault: () => {},
    } as unknown as KeyboardEvent;
    expect(controller.handleKeyEvent(esc)).toBe(false);
    expect(popupStates[1]).toBeNull();
    expect(writes).toHaveLength(1); // nothing erased
  });

  it("appends / for a directory candidate", async () => {
    buffer.line = "host$ cd sub";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "docs", isDir: true }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dir", prefix: "sub", baseDir: "/home/u" }),
    );
    expect(writes).toEqual(["\x7F\x7F\x7Fdocs/"]);
    echo(buffer, "host$ cd ", "docs/");
  });

  it("preserves the typed ~ dirPart when completing (regression)", async () => {
    // `cd ~/Pro<Tab>` must become `cd ~/Projects/` — erasing `~/Pro` and
    // retyping only the candidate name would degrade it to `cd Projects/`.
    buffer.line = "host$ cd ~/Pro";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "Projects", isDir: true }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dir", prefix: "Pro", baseDir: "/home/u/" }),
    );
    expect(writes).toEqual(["\x7F".repeat(5) + "~/Projects/"]);
  });

  it("compares the LCP against the name segment, not the ~-full word", async () => {
    // LCP "Pro" extends the typed prefix "Pr" (3 > 2) — but comparing
    // against the WHOLE word ("~/Pr", 4 chars) would have missed the
    // insertion entirely (3 > 4 is false). The dirPart must not swallow
    // the common prefix, and the result keeps the `~`.
    buffer.line = "host$ cd ~/Pr";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [
        { name: "Projects", isDir: true },
        { name: "Programs", isDir: true },
      ],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toEqual(["\x7F".repeat(4) + "~/Pro"]);
  });

  it("quotes a candidate that needs quoting", async () => {
    buffer.line = "host$ ls My\\ Fi";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "My Files", isDir: false }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    // The typed word `My\ Fi` is 6 raw characters; the insertion is
    // normalized to single-quote style.
    expect(writes).toEqual(["\x7F".repeat(6) + "'My Files'"]);
    echo(buffer, "host$ ls ", "'My Files'");
  });

  it("inserts literally inside an open single quote", async () => {
    buffer.line = "host$ ls 'My Fi";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "My Files", isDir: false }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toEqual(["\x7F".repeat(6) + "My Files"]);
    echo(buffer, "host$ ls ", "My Files");
  });

  it("falls through to a native Tab when there are no candidates", async () => {
    buffer.line = "host$ gre";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => ({ candidates: [] }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toEqual(["\t"]);
  });

  it("falls through when the cursor is not at end-of-line", async () => {
    buffer.line = "host$ gre";
    buffer.cursorX = 7; // mid-word
    const complete = vi.fn();
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(writes).toEqual(["\t"]);
  });

  it("completes on a visually padded row (regression: xterm pads untrimmed lines)", async () => {
    // The REAL xterm row is padded to the full column width; only the
    // trimmed snapshot shows the true end of input. Before the padding
    // fix this exact scenario silently degraded to passthrough.
    buffer.line = "host$ gre";
    buffer.cursorX = 9;
    buffer.padWidth = 120;
    const complete = vi.fn(async () => ({
      candidates: [{ name: "grep", isDir: false }],
    }));
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(["\x7F\x7F\x7Fgrep "]);
  });

  it("falls through in the alternate buffer (vim, htop)", async () => {
    buffer.line = "whatever";
    buffer.cursorX = 8;
    buffer.type = "alternate";
    const complete = vi.fn();
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(writes).toEqual(["\t"]);
  });

  it("falls through when the backend command fails", async () => {
    buffer.line = "host$ gre";
    buffer.cursorX = buffer.line.length;
    const complete = vi.fn(async () => {
      throw new Error("boom");
    });
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toEqual(["\t"]);
  });

  it("drops a stale result when the line changed while awaiting", async () => {
    buffer.line = "host$ gre";
    buffer.cursorX = buffer.line.length;
    let resolveComplete: (value: { candidates: { name: string; isDir: boolean }[] }) => void =
      () => {};
    const complete = vi.fn(
      () =>
        new Promise<{ candidates: { name: string; isDir: boolean }[] }>((resolve) => {
          resolveComplete = resolve;
        }),
    );
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    // The user keeps typing (or output moves the cursor) before the answer.
    buffer.line = "host$ grep";
    buffer.cursorX = buffer.line.length;
    resolveComplete({ candidates: [{ name: "grep", isDir: false }] });
    await flush();

    expect(writes).toEqual([]); // nothing written, cycle dropped
  });

  it("invalidates the cycle when the user types", async () => {
    buffer.line = "host$ dock";
    buffer.cursorX = buffer.line.length;
    const complete = dockerComplete();
    const { writes, deps } = makeDeps(complete);
    const controller = createCompletionController(makeTerm(buffer), deps);

    controller.handleKeyEvent(tabEvent());
    await flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("\x7F".repeat(4) + "docker"); // LCP, no suffix
    echo(buffer, "host$ ", "docker");

    // The user deletes a character — any input invalidates the cycle.
    controller.notifyInput("\x7F");
    buffer.line = "host$ doc";
    buffer.cursorX = buffer.line.length;

    controller.handleKeyEvent(tabEvent()); // must start a FRESH request
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2);
    // The fresh request re-inserts the LCP over the new word.
    expect(writes[1]).toBe("\x7F".repeat(3) + "docker");
  });
});

describe("promptPrefixLength", () => {
  it("finds the last $ # or % chunk", () => {
    expect(promptPrefixLength("egor@host:~$ ls Do")).toBe(13);
    expect(promptPrefixLength("root@host:~# apt ins")).toBe(13);
    expect(promptPrefixLength("user@host ~ % ls")).toBe(14);
    expect(promptPrefixLength("$ ls")).toBe(2);
  });

  it("returns 0 when no prompt delimiter is present", () => {
    expect(promptPrefixLength("plain line")).toBe(0);
    expect(promptPrefixLength("")).toBe(0);
  });
});

describe("longestCommonPrefix", () => {
  it("computes the shared prefix", () => {
    expect(longestCommonPrefix(["docker", "docker-compose"])).toBe("docker");
    expect(longestCommonPrefix(["abc", "abd"])).toBe("ab");
    expect(longestCommonPrefix(["a", "b"])).toBe("");
    expect(longestCommonPrefix(["solo"])).toBe("solo");
    expect(longestCommonPrefix([])).toBe("");
  });
});

describe("rawInsertion", () => {
  it("inserts plain names as-is outside quotes", () => {
    expect(rawInsertion("docker", { quote: null })).toBe("docker");
  });

  it("single-quotes names with special characters", () => {
    expect(rawInsertion("My Files", { quote: null })).toBe("'My Files'");
    expect(rawInsertion("a'b", { quote: null })).toBe("'a'\\''b'");
  });

  it("inserts literally inside single quotes", () => {
    expect(rawInsertion("My Files", { quote: "'" })).toBe("My Files");
  });

  it("backslash-escapes inside double quotes", () => {
    expect(rawInsertion('say "hi"', { quote: '"' })).toBe('say \\"hi\\"');
    expect(rawInsertion("$x", { quote: '"' })).toBe("\\$x");
  });

  it("never quotes ~ (bash tilde expansion must survive)", () => {
    expect(rawInsertion("~/Projects", { quote: null })).toBe("~/Projects");
    expect(rawInsertion("~", { quote: null })).toBe("~");
  });
});
