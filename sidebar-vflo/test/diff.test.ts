import { describe, expect, it } from "vitest";
import { loadDiff, parseNumstat, parseUntracked, type ExecFn } from "../src/diff.js";

describe("git diff parsing", () => {
	it("parses -z numstat records, including binary files and paths with tabs", () => {
		expect(parseNumstat("10\t2\tsrc/a.ts\0-\t-\tlogo.png\0" + "1\t0\tweird\tname.ts\0")).toEqual([
			{ path: "src/a.ts", added: 10, removed: 2, untracked: false },
			{ path: "logo.png", added: null, removed: null, untracked: false },
			{ path: "weird\tname.ts", added: 1, removed: 0, untracked: false },
		]);
		expect(parseUntracked("new.ts\0dir/other.ts\0")).toEqual([
			{ path: "new.ts", added: null, removed: null, untracked: true },
			{ path: "dir/other.ts", added: null, removed: null, untracked: true },
		]);
	});
});

describe("loadDiff", () => {
	const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
	const fail = { stdout: "", stderr: "fatal", code: 128, killed: false };

	it("merges tracked and untracked files, sorted by path", async () => {
		const exec: ExecFn = async (_command, args) =>
			args.includes("ls-files") ? ok("b-new.ts\0") : ok("1\t1\tc.ts\0" + "2\t0\ta.ts\0");
		const diff = await loadDiff(exec, "/repo");
		expect(diff?.files.map((file) => file.path)).toEqual(["a.ts", "b-new.ts", "c.ts"]);
	});

	it("falls back to the empty tree when HEAD does not exist yet", async () => {
		const exec: ExecFn = async (_command, args) => {
			if (args.includes("HEAD")) return fail;
			return args.includes("ls-files") ? ok("") : ok("3\t0\tfirst.ts\0");
		};
		expect(await loadDiff(exec, "/repo")).toEqual({ files: [{ path: "first.ts", added: 3, removed: 0, untracked: false }] });
	});

	it("returns undefined outside a git repository so the panel is hidden", async () => {
		expect(await loadDiff(async () => fail, "/tmp")).toBeUndefined();
		expect(await loadDiff(async () => { throw new Error("git: not found"); }, "/tmp")).toBeUndefined();
	});
});
