/**
 * Erase BEFORE writing. After a full-width row, terminals can leave the cursor
 * on its final cell with autowrap pending; EL/ED there deletes that last cell.
 * Explicitly position below short frames before clearing unused screen rows.
 */
export function terminalFrame(lines, height, previous) {
  if (previous) {
    let output = "";
    for (const [index, line] of lines.slice(0, Math.max(0, height)).entries()) {
      if (line === previous[index]) continue;
      // Frames pad every row to the viewport width. Overwrite changed rows
      // directly: erase-then-paint exposes the default background as a flash.
      output += `\x1b[${index + 1};1H\x1b[0m` + line + "\x1b[0m";
    }
    if (lines.length < previous.length && lines.length < height) output += `\x1b[${lines.length + 1};1H\x1b[0m\x1b[J`;
    return output;
  }
  const rows = lines.slice(0, Math.max(0, height));
  let output = "\x1b[H" + rows.map((line) => "\x1b[2K" + line).join("\r\n") + "\x1b[0m";
  if (rows.length < height) output += `\x1b[${rows.length + 1};1H\x1b[J`;
  return output;
}
