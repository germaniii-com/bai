import type { ModelInfo } from "@bai/shared";
import { modelCapabilities } from "@bai/shared";
import { Brain, Eye } from "lucide-react";

/**
 * Inline capability glyphs for a model (`think` / `vision`). Each glyph
 * carries a `data-tooltip` rendered by the global tooltip layer:
 * "This model supports thinking" / "This model supports vision".
 *
 * Renders nothing when the catalog attests no capability — unknown stays
 * unknown (see @bai/shared capabilities).
 */
export function ModelCapabilityBadges({ model }: { model: ModelInfo }) {
  const caps = modelCapabilities(model);
  if (caps.length === 0) return null;
  return (
    <span className="model-caps">
      {caps.map((cap) => {
        const Icon = cap.key === "thinking" ? Brain : Eye;
        return (
          <span
            key={cap.key}
            className={`model-cap model-cap-${cap.key}`}
            data-tooltip={cap.hint}
            role="img"
            aria-label={cap.hint}
          >
            <Icon size={12} aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
}
