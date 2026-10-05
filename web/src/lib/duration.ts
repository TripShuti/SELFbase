/**
 * Duration helpers: whole minutes <-> `"80h 3m"`.
 *
 * Mirrors `parse_duration_text` / `format_duration` in
 * `server/spacetimedb/src/pages/schemas.rs` — keep the two in sync.
 * The canonical storage unit is whole minutes (u64 server-side, bigint
 * client-side); the `Xh Ym` shape is display/input only.
 */

/** Parse `80h 3m`, `80:03`, `90m`, `2h`, bare `90` (minutes) → total minutes. */
export function parseDurationText(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toLowerCase().replace(",", ".");
  if (t === "") return null;

  // `H:MM` — hours unbounded, minutes must be < 60.
  const colon = t.indexOf(":");
  if (colon !== -1) {
    const h = Number(t.slice(0, colon).trim());
    const m = Number(t.slice(colon + 1).trim());
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m >= 60) {
      return null;
    }
    return h * 60 + m;
  }

  // Token scan: numbers with optional h/m/s suffix; bare number = minutes.
  let total = 0;
  let any = false;
  let num = "";
  const flush = (suffix: "h" | "m" | "s" | null): boolean => {
    if (num === "") return false;
    const n = Number(num);
    num = "";
    if (!Number.isFinite(n) || n < 0) return false;
    if (suffix === "h") total += Math.round(n * 60);
    else if (suffix === "m" || suffix === null) total += Math.round(n);
    else total += Math.round(n / 60);
    any = true;
    return true;
  };

  for (const c of t) {
    if ((c >= "0" && c <= "9") || c === ".") {
      num += c;
      continue;
    }
    if (c === " " || c === "\t") continue;
    if (c === "h" || c === "m" || c === "s") {
      if (!flush(c)) return null;
      continue;
    }
    return null;
  }
  if (num !== "" && !flush(null)) return null;
  return any ? total : null;
}

/** Format whole (or fractional — rounded) minutes as `80h 3m`. Hours unbounded. */
export function formatDuration(minutes: number | bigint): string {
  const total = typeof minutes === "bigint" ? Number(minutes) : Math.round(minutes);
  if (!Number.isFinite(total) || total < 0) return "0h 0m";
  const t = Math.round(total);
  return `${Math.floor(t / 60)}h ${t % 60}m`;
}
