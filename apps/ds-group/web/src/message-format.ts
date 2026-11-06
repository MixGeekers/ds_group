export type MessagePart = {
  kind: "text" | "code" | "pre" | "strong" | "link";
  text: string;
  offset: number;
  href?: string;
};

function bareLinkEnd(value: string): string {
  let url = value.replace(/[.,;:!?]+$/, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length)
      url = url.slice(0, -1);
  }
  return url;
}

/** Small chat formatter; code stays literal and links only admit HTTP(S). */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const expression = /```(?:[\w+-]*\n)?([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()<>]+|\([^\s()<>]*\))+)\)|(https?:\/\/[^\s<>，。；：！？、（）【】《》“”‘’]+)/gi;
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > offset)
      parts.push({ kind: "text", text: text.slice(offset, match.index), offset });
    const at = match.index;
    if (match[1] !== undefined) parts.push({ kind: "pre", text: match[1], offset: at });
    else if (match[2] !== undefined) parts.push({ kind: "code", text: match[2], offset: at });
    else if (match[3] !== undefined) parts.push({ kind: "strong", text: match[3], offset: at });
    else if (match[4] !== undefined)
      parts.push({ kind: "link", text: match[4], href: match[5], offset: at });
    else {
      const href = bareLinkEnd(match[6]);
      parts.push({ kind: "link", text: href, href, offset: at });
      if (href.length < match[6].length)
        parts.push({ kind: "text", text: match[6].slice(href.length), offset: at + href.length });
    }
    offset = at + match[0].length;
  }
  if (offset < text.length) parts.push({ kind: "text", text: text.slice(offset), offset });
  return parts;
}
