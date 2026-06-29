import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The web UI reuses the desktop app's SINGLE global stylesheet so the look is
// identical (tokens, BEM-ish classes). See docs/ui-conventions.md.
import "@app/styles/theme.css";
// Web-only overrides layered on top of the shared theme (login card, sidebar
// nav families, theme toggle). Must load AFTER theme.css.
import "./styles/web.css";
import "./i18n";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
