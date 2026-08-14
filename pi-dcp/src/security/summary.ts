import { sha256 } from "../util/hash.ts";
export function securitySummary(summary: string): { length: number; hash: string; hasControls: boolean } { return { length: summary.length, hash: sha256(summary), hasControls: [...summary].some((char) => char.charCodeAt(0) < 0x20 && !"\n\r\t".includes(char)) }; }
export function containsSecretCanary(value: string, canaries: readonly string[]): boolean { return canaries.some((canary) => Boolean(canary) && value.includes(canary)); }
