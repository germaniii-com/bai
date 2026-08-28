import { Box, Text } from "ink";

/** Structured placeholder for views landing in later phases (D9 honesty). */
export function PlaceholderView({ title, phase }: { title: string; phase: number }) {
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      <Text bold>{title}</Text>
      <Text dimColor>structured stub — lands in Phase {phase}</Text>
    </Box>
  );
}
