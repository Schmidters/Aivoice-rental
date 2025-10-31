// lib/mergeEvents.js
/**
 * 🧩 Merge AI + Outlook events and remove duplicates.
 * Dedupes by propertyId + start time (not title).
 */
export function mergeUniqueEvents(ai, outlook) {
  const merged = [...ai, ...outlook];
  const uniqueMap = new Map();

  for (const e of merged) {
    // 🧠 Normalize time to the nearest minute
    const startKey = new Date(e.start).toISOString().slice(0, 16);

    // Use propertyId if present, otherwise fallback to title
    const propertyKey = e.propertyId || e.title?.toLowerCase()?.trim() || "unknown";

    const key = `${propertyKey}-${startKey}`;

    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, e);
    } else {
      // 🪄 Merge metadata for cleaner unified event
      const existing = uniqueMap.get(key);
      uniqueMap.set(key, {
        ...existing,
        ...e,
        color: "#3b82f6", // keep Outlook blue if synced
        source: "Outlook+AI",
      });
    }
  }

  return Array.from(uniqueMap.values());
}
