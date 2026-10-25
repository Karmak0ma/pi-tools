import { cells, hitTest } from './view.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const sgr = /\x1b\[[0-9;]*m/g;

// Match the renderer's cell widths, not UTF-16 offsets: a drag through an emoji
// or a combining sequence must copy the whole character, never half of it.
function sliceLine(line, left, right, highlight = false) {
  let column = 1, result = '';
  for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (token.startsWith('\x1b[')) { if (highlight) result += token; continue; }
    for (const { segment } of segmenter.segment(token)) {
      const width = cells(segment);
      const selected = column <= right && column + width > left;
      if (highlight) result += selected ? '\x1b[7m' + segment + '\x1b[27m' : segment;
      else if (selected) result += segment;
      column += width;
    }
  }
  return result;
}

/**
 * Mouse-reporting terminals cannot give an already-started drag back to Herdr.
 * Own that gesture here instead. Defer only source/note clicks until release;
 * action buttons still fire on press. Freeze the visible frame until the next
 * input so refresh cannot move text under the pointer or erase the highlight.
 */
export function createTextSelection({ copy, click, onChange, onActive }) {
  let gesture;
  function clear() {
    if (!gesture) return;
    gesture = undefined;
    onActive(false);
    onChange();
  }
  function position(event) {
    return { x: Math.max(gesture.left, Math.min(gesture.right, event.x)),
      y: Math.max(3, Math.min(gesture.frame.lines.length - 3, event.y)) };
  }
  function range(y) {
    let { start, end } = gesture;
    if (start.y > end.y || (start.y === end.y && start.x > end.x)) [start, end] = [end, start];
    if (y < start.y || y > end.y) return undefined;
    return [y === start.y ? start.x : gesture.left, y === end.y ? end.x : gesture.right];
  }
  return {
    clear,
    render() {
      if (!gesture) return undefined;
      return { ...gesture.frame, lines: gesture.frame.lines.map((line, index) => {
        const span = gesture.dragged && range(index + 1);
        return span ? sliceLine(line, ...span, true) : line;
      }) };
    },
    handle(event, frame) {
      const primary = event.type === 'mouse' && (event.button === 0 || event.button === 32);
      if (gesture?.pressed && primary && (event.button === 32 || !event.down)) {
        const end = position(event);
        gesture.dragged ||= end.x !== gesture.start.x || end.y !== gesture.start.y;
        gesture.end = end;
        if (!event.down) {
          gesture.pressed = false;
          if (!gesture.dragged) {
            const press = gesture.press;
            clear(); click(press);
            return true;
          }
          const text = gesture.frame.lines.flatMap((line, index) => {
            const span = range(index + 1);
            return span ? [sliceLine(line.replace(sgr, ''), ...span).trimEnd()] : [];
          }).join('\n');
          // Only an explicit completed drag may write the clipboard. A click,
          // hover, refresh or untrusted source escape must never copy anything.
          if (text) copy(text);
        }
        onChange();
        return true;
      }
      if (gesture && event.type === 'mouse' && (event.button & 32)) return true;
      if (event.type !== 'mouse' || event.down) clear();
      if (!primary || !event.down || event.button !== 0 || !frame) return false;
      const hit = hitTest(frame.hits, event.x, event.y);
      if (!['row', 'note'].includes(hit?.type)) return false;
      gesture = { frame, press: event, left: hit.x1, right: hit.x2, pressed: true, dragged: false,
        start: { x: event.x, y: event.y }, end: { x: event.x, y: event.y } };
      onActive(true);
      return true;
    },
  };
}

/** OSC 52 is consumed by Herdr and forwarded to its clipboard implementation. */
export function clipboardSequence(text) {
  return '\x1b]52;c;' + Buffer.from(text, 'utf8').toString('base64') + '\x07';
}
