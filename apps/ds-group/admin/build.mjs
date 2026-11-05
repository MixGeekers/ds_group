import { copyFile } from "node:fs/promises";
await copyFile(
  new URL("../web/theme.js", import.meta.url),
  new URL("../dist/admin/theme.js", import.meta.url),
);
