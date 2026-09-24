import { EmptyState } from "../components/ui";

/** Structured placeholder for views landing in later phases (D9 honesty). */
export function PlaceholderView({ title, phase }: { title: string; phase: number }) {
  return (
    <EmptyState
      title={title}
      body={`structured stub — lands in Phase ${phase}`}
      hints="esc back"
    />
  );
}
