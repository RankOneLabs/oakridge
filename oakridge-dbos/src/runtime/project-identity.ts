import type { ForgeRepository } from "../storage/json-column-types";

/** The GitHub repository an `origin` remote URL names, or null for any other forge or form. */
export const githubIdentityFromRemote = (remoteValue: string): ForgeRepository | null => {
  const remote = remoteValue.trim().replace(/\/+$/, "");
  const prefixes = ["git@github.com:", "ssh://git@github.com/", "https://github.com/", "http://github.com/"];
  const prefix = prefixes.find((candidate) => remote.startsWith(candidate));
  if (!prefix) return null;
  const path = remote.slice(prefix.length).replace(/\.git$/, "");
  const segments = path.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { provider: "github", owner: segments[0], name: segments[1] };
};
