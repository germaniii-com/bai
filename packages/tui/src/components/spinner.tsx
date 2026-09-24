import { Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Animated braille spinner shown while waiting for the model's first token
 * (and while a run is active). Mounted only while waiting, so the 80ms timer
 * re-renders only this subtree — the transcript stays static.
 *
 * The elapsed seconds are derived from the mount time on each frame (no second
 * interval), and `interruptHint` appends the `esc to interrupt` affordance
 * while a run is actually draining.
 */
export function Spinner({ label, interruptHint = false }: { label?: string; interruptHint?: boolean }) {
  const t = useTheme();
  const [frame, setFrame] = useState(0);
  const startedAt = useRef(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
  return (
    <Text>
      <Text color={t.accent}>{FRAMES[frame]}</Text>
      {label !== undefined && <Text color={t.dim}> {label}…</Text>}
      {seconds >= 1 && <Text color={t.dim}> {seconds}s</Text>}
      {interruptHint && <Text color={t.dim}> · esc to interrupt</Text>}
    </Text>
  );
}
