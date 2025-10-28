// lib/mergeEvents.js

/**
 * 🧩 Merge AI + Outlook events and remove duplicates.
 * Dedupes by title + start time (exact match).
 */
export function mergeUniqueEvents(ai, outlook) {
  const merged = [...ai, ...outlook];

  const uniqueMap = new Map();
  for (const e of merged) {
    const key = `${e.title}-${new Date(e.start).toISOString().slice(0, 16)}`; // normalize time
    if (!uniqueMap.has(key)) uniqueMap.set(key, e);
  }

  return Array.from(uniqueMap.values());
}
