import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const models = ["deepseek-v4-flash-free", "mimo-v2.5-free", "nemotron-3-super-free", "big-pickle"];
describe("vendored provider compatibility metadata", () => { for (const model of models) it(`certifies ${model} fixture metadata`, async () => { const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/providers/opencode-cli", `${model}.json`), "utf8")) as Record<string, unknown>; expect(fixture.api).toBe("opencode-cli-runner"); expect(fixture.credentialFree).toBe(true); expect(typeof fixture.bridgeCommitOrContentHash).toBe("string"); }); });
