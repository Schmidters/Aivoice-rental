"use client";

import { useEffect, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import enUS from "date-fns/locale/en-US";
import { parseISO } from "date-fns";
import "react-big-calendar/lib/css/react-big-calendar.css";

// --- Calendar localization setup ---
const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

export default function BookingsCalendar() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const BACKEND = (process.env.NEXT_PUBLIC_AI_BACKEND_URL || "").replace(/\/$/, "");

  async function loadAll() {
    setLoading(true);
    try {
      const [bookingsRes, availabilityRes] = await Promise.all([
        fetch(`${BACKEND}/api/bookings`, { cache: "no-store" }),
        fetch(`${BACKEND}/api/availability`, { cache: "no-store" }),
      ]);

      const bookings = (await bookingsRes.json()).data || [];
      const availability = (await availabilityRes.json()).data || [];

      // 🟣 Convert bookings into calendar events
      const bookingEvents = bookings.map((b) => ({
        id: `booking-${b.id}`,
        title: `Showing: ${b.property?.facts?.buildingName || b.property?.address || "Unit"} (${b.lead?.phone})`,
        start: new Date(b.datetime),
        end: new Date(new Date(b.datetime).getTime() + (b.duration || 30) * 60000),
        allDay: false,
        type: "booking",
      }));

      // 🟢 Convert availability slots into events
      const availabilityEvents = availability.map((a) => ({
        id: `avail-${a.id}`,
        title: a.isBlocked ? "⛔ Blocked" : "🕓 Available",
        start: new Date(a.startTime),
        end: new Date(a.endTime),
        allDay: false,
        type: a.isBlocked ? "blocked" : "available",
      }));

      setEvents([...bookingEvents, ...availabilityEvents]);
    } catch (err) {
      console.error("❌ Calendar load failed:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();

    // --- Optional: SSE live updates ---
    const es = new EventSource(`${BACKEND}/api/bookings/events`);
    es.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data);
        if (b?.datetime) {
          loadAll(); // re-sync calendar
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  async function handleSelectSlot(slotInfo) {
    const startTime = slotInfo.start;
    const endTime = slotInfo.end;

    const isBlocked = !window.confirm(
      "Add this as an available time? (Cancel to block)"
    );

    const notes = prompt("Optional notes for this slot:") || "";

    const res = await fetch(`${BACKEND}/api/availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        propertySlug: "215-16-street-southeast", // ✅ Temporary — later tie to selected property
        startTime,
        endTime,
        isBlocked,
        notes,
      }),
    });

    const j = await res.json();
    if (j.ok) {
      alert("✅ Slot added successfully!");
      loadAll();
    } else {
      alert("❌ Failed to save slot: " + j.error);
    }
  }

  return (
    <div className="p-6 h-[calc(100vh-80px)] bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          📅 Showings & Availability
        </h1>
        <span className="text-sm text-gray-500">
          {loading ? "Loading..." : `${events.length} events`}
        </span>
      </div>

      <Calendar
        selectable
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        onSelectSlot={handleSelectSlot}
        style={{ height: "calc(100vh - 160px)" }}
        eventPropGetter={(event) => ({
          style: {
            backgroundColor:
              event.type === "booking"
                ? "#4F46E5"
                : event.type === "available"
                ? "#16A34A"
                : "#DC2626",
            borderRadius: "6px",
            color: "white",
            border: "none",
            padding: "2px 4px",
          },
        })}
      />
    </div>
  );
}
