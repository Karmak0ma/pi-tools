import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DcpRuntime } from "../runtime.ts";
import { SAVINGS_SOURCES, readSavingsLedger, type SavingsSource, type SavingsTotals } from "../stats.ts";

const SOURCE_LABELS: Record<SavingsSource, string> = {
  compression: "Range compression",
  deduplication: "Duplicate outputs",
  sweep: "Swept outputs",
  "old-error-input": "Old error inputs",
  "question-input": "Question inputs",
};

export async function statsCommand(ctx: ExtensionCommandContext, runtime: DcpRuntime): Promise<void> {
  const ledger = await readSavingsLedger();
  const session = runtime.reduced.savings;

  // JSON/print/RPC modes have no interactive custom overlay. Keep the same
  // data available as a readable notification instead of silently dropping the
  // command when ctx.ui.custom() cannot take focus.
  if (ctx.mode !== "tui" || typeof (ctx.ui as any).custom !== "function") {
    ctx.ui.notify(formatStatsReport(session, ledger.totals, runtime.sessionFile), "info");
    return;
  }

  await (ctx.ui as any).custom((tui: any, theme: any, keybindings: any, done: () => void) => {
    let selectedTab = 0;
    const matches = (data: string, binding: string, fallback: string): boolean => !!keybindings?.matches?.(data, binding) || matchesKey(data, fallback as any);
    return {
      render(width: number): string[] {
        const totals = selectedTab === 0 ? session : ledger.totals;
        const scope = selectedTab === 0 ? "Current session" : "All sessions";
        const table = formatStatsTable(totals);
        const lines = [
          theme.fg("accent", theme.bold(` ◆ pi-dcp savings — ${scope}`)),
          theme.fg("dim", " " + "═".repeat(Math.min(Math.max(1, width - 2), 72))),
          renderTabs(selectedTab, theme),
          "",
          ...table.map((line, index) => index === table.length - 1 ? theme.fg("accent", line) : theme.fg("muted", line)),
          "",
          theme.fg("dim", selectedTab === 0
            ? `${runtime.sessionFile ? "Session-backed" : "Ephemeral"} statistics; values are cumulative estimates.`
            : "Aggregated from the pi-dcp ledger across all sessions."),
          theme.fg("dim", "Compression and pruning operations are counted once; decompression does not erase history."),
          "",
          theme.fg("dim", "Tab/Shift+Tab switch scope • Esc closes"),
        ];
        const height = tui?.terminal?.rows || process.stdout.rows || lines.length;
        while (lines.length < height) lines.push("");
        return lines.slice(0, height).map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string): void {
        if (matches(data, "tui.input.tab", Key.tab) || matches(data, "tui.input.shiftTab", "shift+tab")) {
          // With exactly two scopes, next and previous are the same toggle.
          selectedTab = (selectedTab + 1) % 2;
          tui.requestRender?.(true);
          return;
        }
        if (matches(data, "tui.select.cancel", Key.escape) || matches(data, "app.session.interrupt", "ctrl+up")) done();
      },
      invalidate(): void {},
    };
  }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
}

export function formatStatsTable(totals: SavingsTotals): string[] {
  const sourceWidth = 28;
  const eventWidth = 8;
  const tokenWidth = 16;
  const divider = `${"─".repeat(sourceWidth)}  ${"─".repeat(eventWidth)}  ${"─".repeat(tokenWidth)}`;
  const lines = [
    `${"Source".padEnd(sourceWidth)}  ${"Events".padStart(eventWidth)}  ${"Tokens saved".padStart(tokenWidth)}`,
    divider,
  ];
  for (const source of SAVINGS_SOURCES) {
    const bucket = totals[source];
    lines.push(`${SOURCE_LABELS[source].padEnd(sourceWidth)}  ${formatInteger(bucket.events).padStart(eventWidth)}  ${formatInteger(bucket.tokens).padStart(tokenWidth)}`);
  }
  const events = SAVINGS_SOURCES.reduce((total, source) => total + totals[source].events, 0);
  const tokens = SAVINGS_SOURCES.reduce((total, source) => total + totals[source].tokens, 0);
  lines.push(divider, `${"Total".padEnd(sourceWidth)}  ${formatInteger(events).padStart(eventWidth)}  ${formatInteger(tokens).padStart(tokenWidth)}`);
  return lines;
}

export function formatStatsReport(session: SavingsTotals, total: SavingsTotals, sessionFile?: string): string {
  const sessionLabel = sessionFile ? "current session" : "current ephemeral session";
  return `pi-dcp savings (${sessionLabel})\n${formatStatsTable(session).join("\n")}\n\nall sessions\n${formatStatsTable(total).join("\n")}`;
}

function renderTabs(selected: number, theme: any): string {
  const session = selected === 0 ? theme.fg("accent", theme.bold("[Session]")) : theme.fg("dim", " Session ");
  const total = selected === 1 ? theme.fg("accent", theme.bold("[Total]")) : theme.fg("dim", " Total ");
  return ` ${session}    ${total}`;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}
