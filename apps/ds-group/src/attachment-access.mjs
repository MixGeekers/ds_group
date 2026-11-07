/** An uploaded ID identifies bytes; it does not grant another account access.
 * References are discovered only from confirmed sends or current Matrix proofs.
 * Old indexes remain readable by the uploader and recover through exact proofs.
 */
export class AttachmentAccess {
  constructor({ media, roomMedia, accounts }) { Object.assign(this, { media, roomMedia, accounts }); }

  async prove({ client, userId, roomId, eventId, attachmentId }) {
    this.accounts.assertActive(userId);
    const proven = await this.roomMedia.prove({ client, userId, roomId, eventId, attachmentId });
    this.media.rememberSource(proven.attachment, { roomId, eventId });
    return proven;
  }

  record(attachments, roomId, eventId) {
    for (const attachment of attachments) this.media.rememberSource(attachment, { roomId, eventId });
  }

  observe(events, roomId) {
    // Opening an old conversation can recover its local source index from real
    // Matrix events. Invalid sender metadata must not break the room timeline.
    for (const event of events) {
      if (event.type !== 'm.room.message' || event.room_id !== roomId || typeof event.event_id !== 'string' || !event.event_id.startsWith('$')) continue;
      const attachments = event.content?.['org.ds_group']?.attachments;
      if (!Array.isArray(attachments)) continue;
      for (const attachment of attachments.slice(0, 10)) {
        if (!attachment || typeof attachment.id !== 'string') continue;
        try { this.media.rememberSource(attachment, { roomId, eventId: event.event_id }); }
        catch (error) { if (![400, 409].includes(error.status)) throw error; }
      }
    }
  }

  async local({ client, userId, id, source }) {
    this.accounts.assertActive(userId);
    const attachment = this.media.get(id);
    if (source) {
      if (typeof source.roomId !== 'string' || !source.roomId || typeof source.eventId !== 'string' || !source.eventId) {
        throw Object.assign(new Error('Both roomId and eventId are required to prove an attachment source'), { status: 400, code: 'INVALID_ATTACHMENT_SOURCE' });
      }
      await this.prove({ client, userId, attachmentId: id, ...source });
      return attachment;
    }
    if (this.media.ownedBy(id, userId)) return attachment;
    for (const reference of this.media.sources(id)) {
      try {
        await this.prove({ client, userId, attachmentId: id, ...reference });
        return attachment;
      } catch (error) {
        if (![400, 403, 404, 409].includes(error.status)) throw error;
      }
    }
    throw Object.assign(new Error('Open the original message or provide its roomId and eventId to access this attachment'), {
      status: 403, code: 'ATTACHMENT_SOURCE_REQUIRED',
    });
  }
}
