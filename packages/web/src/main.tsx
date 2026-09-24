import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initViewportRefit } from "./viewport";
import "./fonts.css";
import "./styles.css";
import "./components/components.css";

// visualViewport → --vvh / --keyboard-inset (iOS keyboard refit). Idempotent
// cleanup is intentionally dropped — one listener set for the app lifetime.
initViewportRefit();

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
