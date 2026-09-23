/**
 * Auto-timestamp rule (Flow 1): when the user starts writing on an empty line,
 * the current video time is prepended to it. Markdown block prefixes typed
 * first (`- `, `1. `, `## `, `> `, `- [ ] `) are kept in front of the stamp.
 */

/** Line content made only of indentation / block markers, i.e. no text yet. */
const PREFIX_ONLY = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)*$/;

/** First characters that most likely start Markdown syntax rather than prose. */
const MARKUP_START = new Set(['#', '-', '*', '+', '>', '|', '`', '[', '!', '~', '=', '_', '<', ':']);

export function shouldAutoStamp(lineBefore: string, typed: string): boolean {
  const first = typed.charAt(0);
  if (first === '' || typed.includes('\n') || /\s/.test(first)) return false;
  if (!PREFIX_ONLY.test(lineBefore)) return false;
  if (MARKUP_START.has(first)) return false;
  // `1.` on an empty line starts an ordered list: wait for the text after it.
  if (lineBefore.trim() === '' && /\d/.test(first)) return false;
  return true;
}
