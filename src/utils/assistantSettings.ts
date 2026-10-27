/** Client-side mirror of the backend loopback boundary used for UI warning. */
export function isLocalAssistantBaseUrl(baseUrl: string): boolean {
  const authority = baseUrl
    .split("://")
    [1]
    ?.split(/[/?#]/)
    [0];
  if (authority === undefined) return false;
  const withoutUser = authority.split("@").slice(-1)[0] ?? authority;
  const bracketed = /^\[(.+)\]/.exec(withoutUser);
  const normalized =
    bracketed?.[1] ?? withoutUser.split(":")[0] ?? withoutUser;
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}
