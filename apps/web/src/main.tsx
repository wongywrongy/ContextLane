import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {/* Sonner without its own look: the classes below are ours (app.css), square and high-contrast. */}
    <Toaster position="bottom-right" gap={6} offset={16} toastOptions={{ unstyled: true, classNames: { toast: "toast", title: "toast-t", description: "toast-d", error: "toast-err", success: "toast-ok", actionButton: "btn sm", closeButton: "toast-x" } }} />
  </StrictMode>,
);
