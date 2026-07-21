// Shared drag-and-drop contract for moving a terminal TAB between regions.
//
// A tab's strip entry is `draggable`; on drag-start it writes the tab's
// session id under this custom MIME type. A region body is a drop target that
// reads it back and calls `terminalStore.moveTabToRegion`. The custom type
// (rather than `text/plain`) keeps foreign drags (files, selected text) from
// being mistaken for a tab move.

export const TERMINAL_TAB_DND_TYPE = "application/x-procmix-terminal-tab";
