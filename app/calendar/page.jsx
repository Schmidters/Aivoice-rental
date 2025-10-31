"use client";

import "@/styles/calendar-modern.css";

import { useEffect, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { Drawer } from "@/components/ui/drawer";
import { Calendar, Clock, MapPin } from "lucide-react";
import { motion } from "framer-motion";
import { mergeUniqueEvents } from "@/lib/mergeEvents";

export default function CalendarPage() {
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const BACKEND =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
    "https://api.cubbylockers.com";

  // 🧩 Fetch both AI + Outlook events
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

const ai = (bookingsJson.data || []).map((b) => {
  const start = new Date(b.datetime);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  return {
  id: "AI-" + b.id,
  title: b.property?.address || "AI Showing",
  start,
  end,
  color: "#22c55e",
  source: "AI",
  className: "ai",
  phone: b.lead?.phone || "",
  leadName: b.lead?.name || "Unknown lead",       // 👤 new
  unitType: b.property?.unitType || b.unit || "N/A", // 🏠 new
};

});

const outlook = (outlookJson.data || []).map((e) => ({
  id: e.id,
  title: e.title || "Outlook Event",
  start: new Date(e.start), // ✅ Date objects
  end: new Date(e.end),
  color: "#3b82f6",
  source: "Outlook",
  className: "outlook",
  location: e.location,
  webLink: e.webLink,
}));

const merged = mergeUniqueEvents(ai, outlook);
setEvents(merged);

      console.log("✅ Normalized events sample:", merged[0]);
      console.log("📅 Final events for FullCalendar:", merged);

    } catch (err) {
      console.error("❌ Failed to fetch events:", err);
    }
  }

  useEffect(() => {
    fetchAll();
  }, [BACKEND]);

  // 🕒 Auto-refresh every 60 seconds
  useEffect(() => {
    const timer = setInterval(fetchAll, 60000);
    return () => clearInterval(timer);
  }, []);

  const upcoming = [...events]
    .filter((e) => new Date(e.start) >= new Date())
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 4);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col p-6 space-y-8">
      {/* ====================== */}
      {/* CALENDAR + UPCOMING EVENTS */}
      {/* ====================== */}
      <div className="flex flex-1 gap-8">
        {/* Sidebar: Upcoming */}
        <div className="w-80 calendar-glass p-6 space-y-6 border-none shadow-md bg-white rounded-xl">
          <h2 className="text-lg font-semibold">Upcoming Events</h2>
          {upcoming.length === 0 ? (
            <p className="text-gray-400 text-sm">No events coming up.</p>
          ) : (
            <div className="space-y-3">
              {upcoming.map((e) => {
                const date = new Date(e.start);
                const label = date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                });
                const timeLabel = date.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                });
                return (
                  <div
                    key={e.id}
                    onClick={() => {
                      setSelected(e);
                      setDrawerOpen(true);
                    }}
                    className="bg-gray-50 hover:bg-gray-100 border border-gray-200 p-3 rounded-lg cursor-pointer transition"
                  >
                    <p className="font-medium text-gray-800 text-sm truncate">
                      {e.title}
                    </p>
                    <p className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                      <Clock className="w-3 h-3" />
                      {label}, {timeLabel}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Calendar */}
        <div className="flex-1 p-6 bg-white rounded-xl shadow-md">
          <FullCalendar
  plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
  initialView="timeGridWeek"
  headerToolbar={{
    left: "prev,next today",
    center: "title",
    right: "dayGridMonth,timeGridWeek,timeGridDay",
  }}
  timeZone="local"
  height="calc(100vh - 240px)"
  nowIndicator={true}
  allDaySlot={false}
  slotDuration="00:30:00"
  slotLabelInterval="01:00:00"
  slotMinTime="08:00:00"
  slotMaxTime="19:00:00"
  contentHeight="auto"           // allows internal scroll again
  scrollTime="09:00:00"          // ✅ valid and fixed format
  events={events}                // ✅ critical line
  eventDisplay="block"           // helps if styles interfere
  eventTimeFormat={{
    hour: "numeric",
    minute: "2-digit",
    meridiem: "short",
  }}
  eventClick={(info) => {
    const ev = events.find((e) => e.id === info.event.id);
    setSelected(ev);
    setDrawerOpen(true);
  }}
  eventContent={(arg) => (
    <motion.div
      whileHover={{ scale: 1.04 }}
      className={`text-white text-xs px-2 py-[2px] rounded-md shadow-sm truncate ${
        arg.event.extendedProps.source === "AI"
          ? "bg-gradient-to-r from-green-400 to-green-600"
          : "bg-gradient-to-r from-blue-400 to-blue-600"
      }`}
    >
      {arg.timeText && <span className="font-medium">{arg.timeText} </span>}
      {arg.event.title}
    </motion.div>
  )}
/>

        </div>
      </div>

      {/* Drawer for event details */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Event Details">
        {selected && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{selected.title}</h2>
            <p className="text-sm text-gray-600 flex items-center gap-2">
              <Calendar className="h-4 w-4" />{" "}
              {new Date(selected.start).toLocaleString()}
            </p>
            {selected.location && (
  <p className="text-sm text-gray-600 flex items-center gap-2">
    <MapPin className="h-4 w-4" /> {selected.location}
  </p>
)}

{/* Lead + Unit Info Section */}
<div className="flex flex-col gap-2 pt-2">
  {selected.leadName && (
    <div className="flex items-center gap-2 text-sm text-gray-700">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-600">
        👤
      </span>
      <span className="bg-gray-100 px-2 py-1 rounded-md">
        {selected.leadName}
      </span>
    </div>
  )}

  {selected.unitType && (
    <div className="flex items-center gap-2 text-sm text-gray-700">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600">
        🏠
      </span>
      <span className="bg-gray-100 px-2 py-1 rounded-md">
        {selected.unitType}
      </span>
    </div>
  )}
</div>

            {selected.webLink && (
              <a
                href={selected.webLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm mt-2 text-blue-600 underline"
              >
                Open in Outlook
              </a>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
