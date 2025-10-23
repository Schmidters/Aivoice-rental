"use client";

import { useEffect, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";

export default function UnifiedCalendar() {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);

  const BACKEND =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
    "https://aivoice-rental.onrender.com";

  // --- Fetch AI bookings + Outlook events ---
  async function fetchAll() {
    try {
      const [bookingsRes, outlookRes] = await Promise.all([
        fetch(`${BACKEND}/api/bookings`, { cache: "no-store" }),
        fetch(`${BACKEND}/api/outlook-sync/events`, { cache: "no-store" }),
      ]);
      const [bookingsJson, outlookJson] = await Promise.all([
        bookingsRes.json(),
        outlookRes.json(),
      ]);

      const ai = (bookingsJson.data || bookingsJson.items || []).map((b) => ({
        id: `ai-${b.id}`,
        title: b.property?.address || "AI Showing",
        start: b.datetime,
        color: "#4f46e5",
        extendedProps: { phone: b.phone, source: "ai" },
      }));

      const outlook = (outlookJson.data || []).map((evt) => ({
        id: `outlook-${evt.id}`,
        title: evt.title || "Outlook Event",
        start: evt.start,
        end: evt.end,
        color: "#2563eb",
        url: evt.webLink,
        extendedProps: { location: evt.location, source: "outlook" },
      }));

      setEvents([...ai, ...outlook]);
    } catch (err) {
      console.error("❌ Error fetching events:", err);
    } finally {
      setLoading(false);
    }
  }

  // --- Auto-refresh every 5 min + SSE for AI ---
  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5 * 60 * 1000);

    const evtSource = new EventSource(`${BACKEND}/api/bookings/events`);
    evtSource.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data);
        setEvents((prev) => [
          {
            id: `ai-${b.id}`,
            title: b.property || "AI Showing",
            start: b.datetime,
            color: "#4f46e5",
            extendedProps: { phone: b.phone, source: "ai" },
          },
          ...prev,
        ]);
      } catch (err) {
        console.warn("⚠️ SSE parse error:", err);
      }
    };

    return () => {
      clearInterval(interval);
      evtSource.close();
    };
  }, []);

  // --- Filtering ---
  const filtered =
    filter === "all"
      ? events
      : events.filter((e) => e.extendedProps.source === filter);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4">
        <div className="flex gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded-lg ${
              filter === "all" ? "bg-gray-800 text-white" : "bg-gray-100"
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilter("ai")}
            className={`px-3 py-1 rounded-lg ${
              filter === "ai" ? "bg-indigo-600 text-white" : "bg-gray-100"
            }`}
          >
            AI Bookings
          </button>
          <button
            onClick={() => setFilter("outlook")}
            className={`px-3 py-1 rounded-lg ${
              filter === "outlook" ? "bg-blue-600 text-white" : "bg-gray-100"
            }`}
          >
            Outlook Events
          </button>
        </div>
        <div className="ml-auto flex gap-4 text-sm">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-indigo-600"></span> AI Booking
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue-600"></span> Outlook Event
          </span>
        </div>
      </div>

      {/* Calendar */}
      {loading ? (
        <p className="text-gray-400">Loading calendar…</p>
      ) : (
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          height="80vh"
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay",
          }}
          events={filtered}
          eventClick={(info) => {
            info.jsEvent.preventDefault();
            const evt = info.event.extendedProps;
            alert(
              `${info.event.title}\n\nSource: ${evt.source}\nLocation: ${
                evt.location || "N/A"
              }\nPhone: ${evt.phone || "N/A"}`
            );
            if (info.event.url) window.open(info.event.url, "_blank");
          }}
        />
      )}
    </div>
  );
}
