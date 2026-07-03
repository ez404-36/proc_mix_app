import React from "react";
import ReactDOM from "react-dom/client";
// Only `Message` and `ConfigProvider` are used from Arco (all visible UI is
// hand-rolled in styles/theme.css), so import ONLY those components' CSS instead
// of the full ~676 KB `dist/css/arco.css`. `Message/style/css.js` pulls in Arco's
// base tokens/reset (`../../style/index.css`, ~24 KB) plus the Message styles;
// ConfigProvider needs only that same base, so this one import covers both.
import "@arco-design/web-react/es/Message/style/css.js";
import "./styles/theme.css";
import "./i18n";
import App from "./App";
import { installContextMenuGuard } from "./utils/contextMenuGuard";

installContextMenuGuard();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
