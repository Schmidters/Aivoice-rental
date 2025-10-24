"use client";

import { useState, useEffect } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { Drawer } from "@/components/ui/drawer";
import { motion } from "framer-motion";
import { Calendar, Clock, MapPin } from "lucide-react";

export default function UnifiedCalendar() {
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const BACKEND =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
    "https://aivoice-rental.onrender.com";

  // 🔹 Fetch both AI and Outlook events
  useEffect(() => {
    async function fetchEvents() {
      try {
        const [bookingsRes, outlookRes] = await Promise.all([
          fetch(`${BACKEND}/api/bookings`, { cache: "no-store" }),
          fetch(`${BACKEND}/api/outlook-sync/events`, { cache: "no-store" }),
        ]);

        const [bookingsJson, outlookJson] = await Promise.all([
          bookingsRes.json(),
          outlookRes.json(),
        ]);

        const aiEvents = (bookingsJson.data || []).map((b) => ({
          id: "AI-" + b.id,
          title: b.property?.address || "AI Showing",
          start: b.datetime,
          end: b.endtime || null,
          color: "#16a34a", // green
          source: "AI",
          phone: b.lead?.phone || "",
          location: b.property?.address,
          unit: b.unit || "",
        }));

        const outlookEvents = (outlookJson.data || []).map((e) => ({
          id: e.id,
          title: e.title || "Outlook Event",
          start: e.start,
          end: e.end,
          color: "#2563eb", // blue
          source: "Outlook",
          location: e.location,
          webLink: e.webLink,
        }));

        setEvents([...aiEvents, ...outlookEvents]);
      } catch (err) {
        console.error("❌ Failed to fetch events:", err);
      }
    }

    fetchEvents();
  }, [BACKEND]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="text-gray-600">
            Combined view of all AI + Outlook showings.
          </p>
        </div>

        {/* 🔹 Simple color legend */}
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-1">
            <span className="w-3 h-3 bg-green-600 rounded-full"></span> AI Showing
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3 h-3 bg-blue-600 rounded-full"></span> Outlook Event
          </div>
        </div>
      </div>

      <div className="rounded-xl overflow-hidden shadow border bg-white">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek" // ✅ weekly default
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay",
          }}
          height="75vh"
          nowIndicator
          events={events}
          eventClick={(info) => {
            const ev = events.find((e) => e.id === info.event.id);
            setSelected(ev);
            setDrawerOpen(true);
          }}
          eventDisplay="block"
          eventContent={(arg) => (
            <motion.div
              layout
              className={`text-white text-xs px-2 py-1 rounded-md shadow-sm ${
                arg.event.extendedProps.source === "AI"
                  ? "bg-green-600"
                  : "bg-blue-600"
              }`}
            >
              {arg.event.title}
            </motion.div>
          )}
        />
      </div>

      {/* Drawer Panel */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Event Details">
        {selected && (
          <div className="space-y-3">
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
            {selected.unit && (
              <p className="text-sm text-gray-600 flex items-center gap-2">
                🏢 Unit: {selected.unit}
              </p>
            )}
            {selected.phone && (
              <p className="text-sm text-gray-600 flex items-center gap-2">
                📱 {selected.phone}
              </p>
            )}
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
