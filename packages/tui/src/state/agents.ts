/**
 * Agent switching for the TUI's Tab / Shift+Tab bindings — opencode's
 * agent_cycle / agent_cycle_reverse. Pure so the wraparound math and the
 * terminal spellings of Shift+Tab are unit-testable without a terminal.
 */

/**
 * Next agent name after `current`, stepping by `delta` with wraparound. An
 * unknown/absent current agent enters at the list's start (forward) or end
 * (reverse). Returns undefined for an empty list.
 */
export function cycleAgentName(
  names: readonly string[],
  current: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (names.length === 0) return undefined;
  const index = current === undefined ? -1 : names.indexOf(current);
  if (index < 0) return delta === 1 ? names[0] : names[names.length - 1];
  return names[(index + delta + names.length) % names.length];
}

/**
 * Decode a Tab / Shift+Tab keypress into a cycle delta, or null for anything
 * else.
 *
 * Shift+Tab arrives in several terminal spellings: the classic backtab
 * `ESC [ Z`, kitty's CSI u (`ESC [ 9 ; 2 u`), and xterm modifyOtherKeys
 * (`ESC [ 27 ; 2 ; 9 ~`). Ink may keep the ESC prefix or strip it:
 * ESC-prefixed forms are unambiguous, while the stripped forms are trusted
 * only when ink also flagged the key as `tab` — so a literal "[Z" typed into
 * the composer is never misread as a shortcut.
 */
export function agentCycleDelta(
  input: string | undefined,
  key: { tab?: boolean; shift?: boolean },
): -1 | 1 | null {
  if (input === "\t") return 1;
  if (input === "\x1b[Z" || input === "\x1b[9;2u" || input === "\x1b[27;2;9~") return -1;
  if (key.tab === true) {
    if (key.shift === true) return -1;
    if (input === "[Z" || input === "[9;2u" || input === "[27;2;9~") return -1;
    return 1;
  }
  return null;
}
