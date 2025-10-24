"use client";

/**
 * FullCalendar CSS Loader — Render-safe
 * Works with FullCalendar 6.1.x and Next.js 14
 */

// Try both modern + fallback paths
import "@fullcalendar/core/internal.css";          // ✅ new base styles (v6.1.15+)
import "@fullcalendar/daygrid/internal.css";       // ✅ modern grid styles
import "@fullcalendar/timegrid/internal.css";      // ✅ modern time-grid styles

export default function FullCalendarStyles() {
  return null;
}
