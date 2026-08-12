/**
 * Shared types for the inspector component tree.
 */

export interface TuiTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}
