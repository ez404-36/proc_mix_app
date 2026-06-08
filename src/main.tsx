import React from "react";
import ReactDOM from "react-dom/client";
import "@arco-design/web-react/dist/css/arco.css";
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
