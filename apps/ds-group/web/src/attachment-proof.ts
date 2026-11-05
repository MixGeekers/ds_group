import type { Attachment, RawRequest } from "./types";

export interface AttachmentSource {
  roomId?: string;
  eventId?: string;
}
function sameDescriptor(original: Attachment, current: Attachment): boolean {
  return (
    !!current &&
    original.id === current.id &&
    original.name === current.name &&
    original.mimeType === current.mimeType &&
    original.size === current.size &&
    (!original.sha256 || original.sha256 === current.sha256) &&
    (!original.contentUri || original.contentUri === current.contentUri)
  );
}
export function roomAttachmentRoute(
  id: string,
  source: AttachmentSource,
  metadata = false,
): string {
  const suffix = metadata ? "/metadata" : "";
  if (source.roomId && source.eventId) {
    return `/api/rooms/${encodeURIComponent(source.roomId)}/attachments/${encodeURIComponent(id)}${suffix}?eventId=${encodeURIComponent(source.eventId)}`;
  }
  return `/api/attachments/${encodeURIComponent(id)}${suffix}`;
}

function legacyMatches(
  original: Attachment,
  current: Attachment,
  homeServerName?: string,
): boolean {
  if (
    !homeServerName ||
    !original.contentUri ||
    !current ||
    !/^mxc:\/\//.test(original.contentUri)
  )
    return false;
  let namespace: string;
  try {
    namespace = new URL(original.contentUri).host;
  } catch {
    return false;
  }
  return namespace === homeServerName && sameDescriptor(original, current);
}

/** A rejected proof never downgrades. Only a positively identified legacy home can use its matching local index. */
export async function attachmentResponse({
  request,
  attachment,
  source,
  allowLegacy = false,
  homeServerName,
  metadata = false,
  signal,
}: {
  request: RawRequest;
  attachment: Attachment;
  source: AttachmentSource;
  allowLegacy?: boolean;
  homeServerName?: string;
  metadata?: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const response = await request(
    roomAttachmentRoute(attachment.id, source, metadata),
    { signal },
  );
  if (metadata && response.ok && source.roomId && source.eventId) {
    const value = (await response.clone().json()) as {
      attachment: Attachment;
      proof: { roomId: string; eventId: string };
    };
    if (
      value.proof?.roomId !== source.roomId ||
      value.proof?.eventId !== source.eventId ||
      !sameDescriptor(attachment, value.attachment)
    )
      throw new Error(
        "The attachment proof does not match the original message",
      );
  }
  if (
    response.status !== 404 ||
    !source.roomId ||
    !source.eventId ||
    !allowLegacy
  )
    return response;
  const legacyMetadata = await request(
    roomAttachmentRoute(attachment.id, {}, true),
    { signal },
  );
  if (!legacyMetadata.ok) return legacyMetadata;
  const value = (await legacyMetadata.clone().json()) as {
    attachment: Attachment;
  };
  if (!legacyMatches(attachment, value.attachment, homeServerName))
    throw new Error(
      "The legacy attachment index does not match this home message",
    );
  if (metadata) return legacyMetadata;
  return request(roomAttachmentRoute(attachment.id, {}), { signal });
}
