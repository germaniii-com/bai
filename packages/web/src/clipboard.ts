/**
 * Clipboard image extraction, shared by the composer hub and the media
 * workbenches (Image/Video). A screenshot or a copied image arrives as a
 * File on the clipboard's `files`/`items`; text-only pastes yield an empty
 * array, so callers can leave ordinary text pasting untouched.
 */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const files: File[] = [];
  // `files` is the most reliable source for screenshots (an actual image/png
  // File); it is empty for purely textual pastes.
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith("image/")) files.push(file);
  }
  if (files.length === 0) {
    // Fallback for browsers/paths that only populate `items`.
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file !== null && file !== undefined) files.push(file);
      }
    }
  }
  return files;
}
