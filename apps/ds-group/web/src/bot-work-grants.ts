export const fileTools = ["read", "write", "edit", "read_image"] as const;
export type FileTool = (typeof fileTools)[number];
export interface BotWorkGrant {
  roomId: string;
  requesterIds: string[];
  tools: FileTool[];
  enabled: boolean;
}
export interface BotWorkGrantDocument {
  revision: number;
  grants: BotWorkGrant[];
}
export function parseWorkGrants(value: unknown): BotWorkGrantDocument {
  const document = value as BotWorkGrantDocument | null;
  if (
    !document ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    !Array.isArray(document.grants) ||
    document.grants.length > 100
  )
    throw new Error("Invalid Bot work grant document");
  const rooms = new Set<string>();
  const unique = (values: unknown): values is string[] =>
    Array.isArray(values) &&
    values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length;
  return {
    revision: document.revision,
    grants: document.grants.map((grant) => {
      if (
        !grant ||
        typeof grant.roomId !== "string" ||
        !/^![^\s]{1,500}$/.test(grant.roomId) ||
        rooms.has(grant.roomId) ||
        typeof grant.enabled !== "boolean" ||
        !unique(grant.requesterIds) ||
        grant.requesterIds.length > 100 ||
        grant.requesterIds.some((id) => !/^@[^\s:]+:[^\s]+$/.test(id)) ||
        !unique(grant.tools) ||
        grant.tools.some(
          (tool) => !(fileTools as readonly string[]).includes(tool),
        )
      )
        throw new Error("Invalid Bot room work grant");
      rooms.add(grant.roomId);
      return {
        roomId: grant.roomId,
        requesterIds: [...grant.requesterIds].sort(),
        tools: [...grant.tools].sort(),
        enabled: grant.enabled,
      };
    }),
  };
}
export function equalWorkGrants(
  left: BotWorkGrantDocument,
  right: BotWorkGrantDocument,
): boolean {
  const sorted = (value: BotWorkGrantDocument) =>
    parseWorkGrants(value).grants.sort((a, b) =>
      a.roomId.localeCompare(b.roomId),
    );
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
