"use client";

import { PageIcon } from "./PageIcon";

/**
 * Shared property-type icons (Lucide, via `PageIcon`).
 *
 * Single source of truth for the `◉`/`📅`-style glyphs that used to live
 * copy-pasted in `GridView` (`PropertyTypeIcon`) and `PagePropertiesPanel`
 * (`PropIcon`). Values are `lucide:<name>` references — raw emoji must not
 * be added here; user-chosen page emoji lives in page `icon` fields instead.
 */
export const PROPERTY_TYPE_ICONS: Record<string, string> = {
  Text: "lucide:type",
  Number: "lucide:hash",
  Date: "lucide:calendar",
  Select: "lucide:circle-dot",
  MultiSelect: "lucide:list",
  Relation: "lucide:arrow-up-right",
  Checkbox: "lucide:square-check",
  Url: "lucide:link",
  Person: "lucide:user",
  File: "lucide:paperclip",
  Formula: "lucide:sigma",
  Rollup: "lucide:layers",
  Duration: "lucide:timer",
};

export function PropertyTypeIcon({
  type,
  size = 13,
  className,
}: {
  type: string;
  size?: number;
  className?: string;
}) {
  const icon = PROPERTY_TYPE_ICONS[type] ?? "lucide:type";
  return (
    <PageIcon
      icon={icon}
      size={size}
      className={className ?? "text-neutral-400 dark:text-neutral-500"}
    />
  );
}
