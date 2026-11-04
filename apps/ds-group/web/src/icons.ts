import {
  createElement,
  Download,
  Eye,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  RotateCcw,
  Square,
  X,
} from "lucide";
import type { IconNode } from "lucide";
import type { Attachment } from "./types";

const actionIcons = {
  close: X,
  download: Download,
  preview: Eye,
  retry: RotateCcw,
  stop: Square,
};

function createIcon(icon: IconNode) {
  return createElement(icon, {
    width: "20",
    height: "20",
    stroke: "currentColor",
    "stroke-width": "2",
    "aria-hidden": "true",
    focusable: "false",
    class: "icon",
  });
}

export function createActionIcon(name: keyof typeof actionIcons) {
  return createIcon(actionIcons[name]);
}

export function createFileIcon(
  attachment: Pick<Attachment, "name" | "mimeType">,
) {
  const extension =
    String(attachment.name || "")
      .split(".")
      .at(-1)
      ?.toLowerCase() ?? "";
  const mime =
    String(attachment.mimeType || "")
      .split(";")[0]
      ?.toLowerCase() ?? "";
  let icon = File;
  if (/^(csv|xls|xlsx|xlsm|ods)$/.test(extension)) icon = FileSpreadsheet;
  else if (mime.startsWith("image/")) icon = FileImage;
  else if (mime.startsWith("audio/")) icon = FileAudio;
  else if (mime.startsWith("video/")) icon = FileVideo;
  else if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(extension)) icon = FileArchive;
  else if (
    /^(js|mjs|cjs|ts|tsx|jsx|json|py|sh|yaml|yml|xml|html|css)$/.test(extension)
  )
    icon = FileCode;
  else if (
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    /^(doc|docx|odt)$/.test(extension)
  )
    icon = FileText;
  return createIcon(icon);
}
