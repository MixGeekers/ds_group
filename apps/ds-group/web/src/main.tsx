import { createRoot } from "react-dom/client";
import App from "./App";
import { loadClientConfig } from "./client-config";
import "../tokens.css";
import "../../ui/tailwind.css";
import "../styles.css";
import "../../ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("DSCord root element is missing");
try {
  const config = await loadClientConfig();
  createRoot(root).render(<App config={config} />);
} catch (error) {
  const message = document.createElement("p");
  message.className = "notice notice-error";
  message.role = "alert";
  message.textContent = error instanceof Error ? error.message : String(error);
  root.replaceChildren(message);
}
