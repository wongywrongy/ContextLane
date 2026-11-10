import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {/* Sonner without its own look: the classes below are ours (app.css), square and high-contrast. */}
  </StrictMode>,
);
