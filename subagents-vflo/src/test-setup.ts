/**
 * Make the suite hermetic against the environment that launched it.
 *
 * The tests are often run by a Pi agent. When that agent is itself a subagent
 * (or runs inside a Herdr pane), it exports markers that change runtime
 * behaviour: the nesting-depth marker makes the recursion guard refuse every
 * spawn at the maximum depth, and the Herdr markers select the Herdr backend.
 * Tests that need these markers stub them explicitly with vi.stubEnv.
 *
 * The markers are deleted (not stubbed) on purpose: vi.unstubAllEnvs restores
 * the value that existed before the first stub, which must be "absent" here,
 * never the host value.
 */
import { HERDR_ENV_VAR, HERDR_PANE_ID_VAR } from "./herdr.js";
import { NESTING_DEPTH_ENV } from "./runner.js";

for (const name of [NESTING_DEPTH_ENV, HERDR_ENV_VAR, HERDR_PANE_ID_VAR]) {
  delete process.env[name];
}
