import { Text } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Animated braille spinner shown while waiting for the model's first token.
 * Mounted only while waiting, so the timer runs (and re-renders happen) only
 * when the indicator is actually visible.
 */
export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text dimColor>
      {FRAMES[frame]}
      {label !== undefined ? ` ${label}` : ""}
    </Text>
  );
}
