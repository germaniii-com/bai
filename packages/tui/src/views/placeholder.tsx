import { Box, Text } from "ink";
import { useTheme } from "../theme";

/** Structured placeholder for views landing in later phases (D9 honesty). */
export function PlaceholderView({ title, phase }: { title: string; phase: number }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      <Text bold>{title}</Text>
      <Text color={t.dim}>structured stub — lands in Phase {phase}</Text>
      <Text color={t.dim}>esc back</Text>
    </Box>
  );
}
