import { createRoot } from "react-dom/client";
import AdminApp from "./AdminApp";
import "../../web/tokens.css";
import "../../ui/tailwind.css";
import "./styles.css";
import "../../ui/styles.css";
const root = document.getElementById("root");
if (!root) throw new Error("DSCord administration root is missing");
createRoot(root).render(<AdminApp />);
