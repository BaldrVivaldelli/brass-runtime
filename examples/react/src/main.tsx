import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BrassProvider } from "./brass";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrassProvider>
      <App />
    </BrassProvider>
  </StrictMode>,
);

