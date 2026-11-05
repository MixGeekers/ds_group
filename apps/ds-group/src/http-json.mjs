export async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 131072)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Expected JSON body"), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Object.assign(new Error("Expected a JSON object"), { status: 400 });
  return parsed;
}
