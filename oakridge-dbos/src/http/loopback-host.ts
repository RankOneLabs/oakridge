const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim().toLowerCase());

