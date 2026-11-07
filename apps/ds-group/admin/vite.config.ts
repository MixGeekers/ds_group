import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/admin-api": process.env.DS_GROUP_ADMIN_URL || "http://127.0.0.1:18110",
    },
    fs: { allow: [path.join(root, "..")] },
  },
  build: { outDir: "../dist/admin", emptyOutDir: true, target: "es2022", license: { fileName: "licenses/bundled-dependencies.txt" } },
});
