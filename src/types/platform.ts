export type Platform = "linux" | "macos" | "windows";
export type PlatformOrUnknown = Platform | "unknown";

export const ALL_PLATFORMS: readonly Platform[] = [
  "linux",
  "macos",
  "windows",
] as const;

export function isPlatform(value: string): value is Platform {
  return (ALL_PLATFORMS as readonly string[]).includes(value);
}
