"use client";

import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowUpRight,
  Bell,
  BookOpen,
  Bookmark,
  Briefcase,
  Calendar,
  Check,
  CircleDot,
  Clock,
  Coffee,
  Compass,
  Database,
  FileText,
  Flag,
  Folder,
  Gamepad2,
  Gift,
  Globe,
  Hash,
  Heart,
  Hourglass,
  House,
  Image,
  Inbox,
  Layers,
  LayoutGrid,
  Lightbulb,
  Link,
  List,
  Map,
  Mic,
  Music,
  Newspaper,
  Paperclip,
  Pin,
  Plus,
  Presentation,
  Rocket,
  Search,
  Settings,
  Sigma,
  Smile,
  Sparkles,
  SquareCheck,
  Star,
  Table,
  Tag,
  Tags,
  Target,
  Timer,
  TrendingUp,
  Trophy,
  Type,
  User,
  Users,
  Video,
  Wallet,
  Zap,
} from "lucide-react";

/** Curated icon set (kebab-name → component). Stored as `lucide:<name>`. */
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  "gamepad-2": Gamepad2,
  trophy: Trophy,
  flag: Flag,
  bookmark: Bookmark,
  calendar: Calendar,
  clock: Clock,
  tag: Tag,
  tags: Tags,
  check: Check,
  "circle-dot": CircleDot,
  "arrow-up-right": ArrowUpRight,
  "square-check": SquareCheck,
  layers: Layers,
  type: Type,
  hash: Hash,
  sigma: Sigma,
  "file-text": FileText,
  folder: Folder,
  image: Image,
  music: Music,
  "book-open": BookOpen,
  coffee: Coffee,
  briefcase: Briefcase,
  users: Users,
  user: User,
  heart: Heart,
  rocket: Rocket,
  target: Target,
  lightbulb: Lightbulb,
  bell: Bell,
  search: Search,
  settings: Settings,
  database: Database,
  table: Table,
  link: Link,
  globe: Globe,
  house: House,
  inbox: Inbox,
  archive: Archive,
  pin: Pin,
  sparkles: Sparkles,
  zap: Zap,
  timer: Timer,
  hourglass: Hourglass,
  map: Map,
  compass: Compass,
  newspaper: Newspaper,
  mic: Mic,
  video: Video,
  "trending-up": TrendingUp,
  wallet: Wallet,
  gift: Gift,
  star: Star,
  plus: Plus,
  list: List,
  "layout-grid": LayoutGrid,
  paperclip: Paperclip,
  presentation: Presentation,
  smile: Smile,
};

export const LUCIDE_ICON_NAMES = Object.keys(LUCIDE_ICONS).sort();

/** Page icon values that reference the bundled Lucide set. */
export function isLucideIcon(value: string | null | undefined): value is string {
  return !!value && value.startsWith("lucide:");
}

export function lucideIconName(value: string): string | null {
  if (!isLucideIcon(value)) return null;
  const name = value.slice("lucide:".length);
  return LUCIDE_ICONS[name] ? name : null;
}

/**
 * Renders a page icon value: Lucide SVG for `lucide:<name>`, raw emoji
 * text otherwise (backward compatible with existing data).
 */
export function PageIcon({
  icon,
  fallback,
  size = 16,
  className,
}: {
  icon?: string | null;
  /** Shown when icon is null/undefined (e.g. per-type default). */
  fallback?: string;
  size?: number;
  className?: string;
}) {
  const value = icon ?? fallback;
  if (value == null) return null;
  const name = lucideIconName(value);
  if (name) {
    const Cmp = LUCIDE_ICONS[name];
    return <Cmp size={size} className={className} aria-hidden="true" />;
  }
  return (
    <span className={className} aria-hidden="true">
      {value}
    </span>
  );
}
