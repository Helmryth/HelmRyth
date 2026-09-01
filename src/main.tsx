import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geologica";
import "@fontsource-variable/atkinson-hyperlegible-next";
import App from "./App";
import { applySkin, readSkin } from "./lib/skins";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
