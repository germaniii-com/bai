import {
  BookOpen,
  Briefcase,
  ChartColumn,
  CodeXml,
  CreditCard,
  Database,
  Globe,
  ListChecks,
  Mail,
  MessagesSquare,
  Mic,
  Palette,
  Plane,
  Plug,
  Presentation,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { MCP_FALLBACKS, MCP_ICONS } from "./mcp-icons";

/**
 * The icon packs (simple-icons ∪ SVG Logos) are compiled to a small static map
 * by `scripts/generate-mcp-icons.mjs`; these are the lucide fallbacks for the
 * handful of brands neither pack carries. Everything renders monochrome
 * (`currentColor`) to match the app's lucide UI icons.
 */
const LUCIDE_FALLBACKS: Record<string, LucideIcon> = {
  BookOpen,
  CreditCard,
  Database,
  Globe,
  Mail,
  Mic,
  Palette,
  Plane,
  Plug,
  Presentation,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
};

/** Brand mark for an MCP server/catalog entry, else a matching lucide icon. */
export function BrandIcon({ name, size = 16 }: { name: string; size?: number }) {
  const brand = MCP_ICONS[name];
  if (brand !== undefined) {
    return (
      <svg
        className="brand-icon"
        viewBox={brand.viewBox}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: brand.body }}
      />
    );
  }
  const Fallback = LUCIDE_FALLBACKS[MCP_FALLBACKS[name] ?? ""] ?? Plug;
  return <Fallback className="brand-icon" size={size} aria-hidden="true" />;
}

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  "Docs & knowledge": BookOpen,
  "Developer tools": CodeXml,
  Productivity: ListChecks,
  "Communications & CRM": MessagesSquare,
  "Analytics & data": ChartColumn,
  "Payments & finance": CreditCard,
  "Media & creative": Palette,
  "Travel & fitness": Plane,
  Jobs: Briefcase,
};

/** Small lucide icon for a catalog category header. */
export function CategoryIcon({ category, size = 13 }: { category: string; size?: number }) {
  const Icon = CATEGORY_ICONS[category] ?? Plug;
  return <Icon className="brand-icon" size={size} aria-hidden="true" />;
}
