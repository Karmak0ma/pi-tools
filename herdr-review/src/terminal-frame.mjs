/**
 * Erase BEFORE writing. After a full-width row, terminals can leave the cursor
 * on its final cell with autowrap pending; EL/ED there deletes that last cell.
 * Explicitly position below short frames before clearing unused screen rows.
 */
export function terminalFrame(lines, height) {
  const rows = lines.slice(0, Math.max(0, height));
  let output = "\x1b[H" + rows.map((line) => "\x1b[2K" + line).join("\r\n") + "\x1b[0m";
  if (rows.length < height) output += `\x1b[${rows.length + 1};1H\x1b[J`;
  return output;
}
