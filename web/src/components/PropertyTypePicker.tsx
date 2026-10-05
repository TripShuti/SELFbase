"use client";

export type PropertyTypeTag =
  | "Text"
  | "Number"
  | "Date"
  | "Select"
  | "MultiSelect"
  | "Relation"
  | "Checkbox"
  | "Url"
  | "Person"
  | "File"
  | "Formula"
  | "Rollup"
  | "Duration";

import { PageIcon } from "./PageIcon";

const PROPERTY_TYPES: { tag: PropertyTypeTag; icon: string; label: string }[] =
  [
    { tag: "Text", icon: "lucide:type", label: "Text" },
    { tag: "Number", icon: "lucide:hash", label: "Number" },
    { tag: "Date", icon: "lucide:calendar", label: "Date" },
    { tag: "Select", icon: "lucide:circle-dot", label: "Select" },
    { tag: "MultiSelect", icon: "lucide:list", label: "Multi-select" },
    { tag: "Relation", icon: "lucide:arrow-up-right", label: "Relation" },
    { tag: "Checkbox", icon: "lucide:square-check", label: "Checkbox" },
    { tag: "Url", icon: "lucide:link", label: "URL" },
    { tag: "Person", icon: "lucide:user", label: "Person" },
    { tag: "File", icon: "lucide:paperclip", label: "Files & media" },
    { tag: "Formula", icon: "lucide:sigma", label: "Formula" },
    { tag: "Rollup",  icon: "lucide:layers", label: "Rollup" },
    { tag: "Duration", icon: "lucide:timer", label: "Duration" },
  ];

interface PropertyTypePickerProps {
  onSelect: (tag: PropertyTypeTag) => void;
}

/**
 * Pure list of property type options.
 * Positioning, outside-click, and Escape handling are delegated to FloatingPopup.
 */
export function PropertyTypePicker({ onSelect }: PropertyTypePickerProps) {
  return (
    <>
      <div className="px-3 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-100 dark:border-neutral-700">
        Property type
      </div>
      {PROPERTY_TYPES.map(({ tag, icon, label }) => (
        <button
          key={tag}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
          onClick={() => onSelect(tag)}
        >
          <span className="w-4 flex items-center justify-center text-neutral-400 dark:text-neutral-500">
            <PageIcon icon={icon} size={13} />
          </span>
          {label}
        </button>
      ))}
    </>
  );
}
