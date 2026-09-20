// ============================================================================
// Real captured failure transcripts, verbatim, re-derived from
// `~/.pi/agent/sessions/**/*.jsonl` via:
//
//   grep -l '<invoke name=' <session-dir>/*.jsonl
//
// then reading the exact `message.content[].text` (and sibling
// provider/model/stopReason fields) off the matched entry with
// `json.loads(line)` (proper JSON decoding, not a naive string search) so
// these are exactly what Claude actually emitted and pi actually stored --
// not a hand-typed approximation. Kept here, persisted, so a future edit to
// claude-tool-repair/index.ts has real regression coverage instead of relying
// on ad-hoc throwaway scripts (and so these three real, somewhat rare
// failure shapes aren't lost -- they were the only evidence this extension's
// design was built from).
//
// DO NOT "clean up" or reformat the `text` values below. Their exact
// whitespace, garbling, and stray tags are the point.
// ============================================================================

export interface Fixture {
	text: string;
	provider: string;
	model: string;
	stopReason: string;
}

/**
 * Clean, single-call leak. Session:
 * `--home-vflores-repos-breakfast_conquer--/2026-09-09T18-56-42-463Z_01a08787-8bdf-70b9-bb40-2c52e1ebee73.jsonl`
 * entry index 158.
 *
 * Notable: a well-formed `<invoke name="Bash">...</invoke>` immediately
 * followed by a stray, ORPHAN duplicate `<parameter name="command">...
 * </parameter>` with no wrapping `<invoke>` -- a real example of the
 * "trailing garbage" shape `stripIfPureOrphanNoise` exists to clean up.
 */
export const sample1_bash: Fixture = {
	text:
		'<invoke name="Bash">\n<parameter name="command">cd /home/vflores/repos/pi-tools/sidebar-vflo && npx vitest run test/_bench_tmp.test.ts 2>&1 | grep -E "us per frame|✓|×" | head; rm test/_bench_tmp.test.ts && echo "temp bench removed"</parameter>\n</invoke>\n<parameter name="command">cd /home/vflores/repos/pi-tools/sidebar-vflo && npx vitest run test/_bench_tmp.test.ts 2>&1 | grep -E "us per frame|✓|×" | head; rm test/_bench_tmp.test.ts && echo "temp bench removed"</parameter>',
	provider: "anthropic",
	model: "claude-opus-5",
	stopReason: "toolUse",
};

/**
 * Genuinely garbled leak: the model tried to inline a JSON array of edits as
 * an `edits` parameter value and mangled the XML/JSON boundary mid-value
 * (`[{"oldText">...`), producing a captured `edits` value that also swallows
 * a second, never-actually-nested `<parameter name="newText">` tag verbatim.
 * This is the fixture that exercises `hasStructuralResidue` -- a repair
 * MUST abort on this one rather than synthesize an `edit` call with garbage
 * `edits`. Session:
 * `--home-vflores-repos-breakfast_conquer--/2026-08-22T19-43-07-987Z_01a02aff-94d3-7271-bae1-0782f41bbe6c.jsonl`
 * entry index 66.
 */
export const sample2_edit_garbled: Fixture = {
	text:
		'Confirmed the mechanism. Let me verify with a corrected probe separating month-end from normal days.\n<invoke name="Edit">\n<parameter name="path">/home/vflores/repos/breakfast_conquer/tools/sim_stage_probe.gd</parameter>\n<parameter name="edits">[{"oldText">const DAYS := 720\n# Sample the same stage breakdown at these day marks. Comparing the same stage\n# across marks is what turns "this is slow" into "this grows".\nconst SAMPLE_AT := [1, 90, 180, 360, 540, 720]</oldText>\n<parameter name="newText">const DAYS := 720\n# Sample the same stage breakdown at these day marks. Comparing the same stage\n# across marks is what turns "this is slow" into "this grows".\n#\n# The marks are deliberately PAIRED: each month-end day (day_index % 30 == 29)\n# is sampled next to an ordinary day. An earlier version of this probe sampled\n# only month-end days by accident and reported their cost as the per-day cost.\n# The pairing exists so that mistake cannot be repeated silently — a reader can\n# see both numbers side by side and tell which curve belongs to which day kind.\nconst SAMPLE_AT := [30, 60, 90, 120, 180, 240, 360, 420, 540, 600, 720]</parameter>\n</invoke>',
	provider: "anthropic",
	model: "claude-opus-5",
	stopReason: "toolUse",
};

/**
 * Clean, multi-param leak with a genuine prose prefix that must survive as
 * its own text block, plus numeric params (`offset`, `limit`) that must
 * coerce to actual numbers, not strings. Session:
 * `--home-vflores-repos-breakfast_conquer--/2026-08-29T14-16-43-301Z_01a04de1-4225-7dd4-8892-f30746631fdc.jsonl`
 * entry index 544.
 */
export const sample3_read: Fixture = {
	text:
		'The agent did the right thing: it proved the change byte-identical, measured only 0.8%, and reverted under the stop condition. My hypothesis was wrong. That negative result is worth recording so nobody repeats it.\n<invoke name="Read">\n<parameter name="path">/home/vflores/repos/breakfast_conquer-test-improvements/PERFORMANCE_CONSIDERATIONS.md</parameter>\n<parameter name="offset">60</parameter>\n<parameter name="limit">30</parameter>\n</invoke>',
	provider: "anthropic",
	model: "claude-opus-5",
	stopReason: "toolUse",
};
