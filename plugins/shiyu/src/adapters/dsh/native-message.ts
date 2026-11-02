import { createHash } from 'node:crypto';

export interface NativeUserMessage {
  id: string;
  role: 'user';
  content: { type: 'text'; text: string }[];
  source: { kind: 'user' };
}
export type NativeMessageInput = Pick<NativeUserMessage, 'content' | 'source'>;
export type NativeMessageFactory = (input: NativeMessageInput) => NativeUserMessage | Promise<NativeUserMessage>;

let nativeFactory: Promise<NativeMessageFactory> | undefined;
/** Load/validate only: this does not construct a message, open a Session or request inference. */
export function loadNativeMessageFactory(): Promise<NativeMessageFactory> {
  return nativeFactory ??= (async () => {
    const publicModule = '@deepseek-ai/dsh-llm/message';
    const module = await import(publicModule) as { createUserMessage?: NativeMessageFactory };
    if (typeof module.createUserMessage !== 'function') throw new Error('Official native user-message factory is unavailable');
    return module.createUserMessage;
  })();
}
export function nativeMessageHash(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (encoded === undefined) throw new Error('Native message is not serializable');
  return createHash('sha256').update(encoded).digest('hex');
}
export function checkedNativeUserMessage(value: NativeUserMessage, prompt: string): NativeUserMessage {
  if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 || value.role !== 'user'
    || value.source?.kind !== 'user' || !Array.isArray(value.content) || value.content.length !== 1
    || value.content[0]?.type !== 'text' || value.content[0].text !== prompt) throw new Error('Official native user-message factory returned an invalid message');
  return structuredClone(value);
}
