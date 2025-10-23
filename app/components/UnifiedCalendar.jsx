"use client";

import { useEffect, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function UnifiedCalendar() {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
        color: "#6366f1",
        extendedProps: {
          phone: b.phone,
          source: "ai",
          property: b.property?.address || "Unknown",
        },
      }));

      const outlook = (outlookJson.data || []).map((evt) => ({
        id: `outlook-${evt.id}`,
        title: evt.title || "Outlook Event",
        start: evt.start,
        end: evt.end,
        color: "#2563eb",
        url: evt.webLink,
        extendedProps: {
          location: evt.location,
          source: "outlook",
          organizer: evt.organizer,
          attendees: evt.attendees,
        },
      }));

      setEvents([...ai, ...outlook]);
    } catch (err) {
      console.error("❌ Error fetching events:", err);
    } finally {
      setLoading(false);
    }
  }

  // --- Auto-refresh every 5 minutes ---
  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // --- Filter ---
  const filtered =
    filter === "all"
      ? events
      : events.filter((e) => e.extendedProps.source === filter);

  // --- Event click handler ---
  function handleEventClick(info) {
    info.jsEvent.preventDefault();
    setSelectedEvent({
      title: info.event.title,
      start: info.event.start,
      end: info.event.end,
      ...info.event.extendedProps,
      url: info.event.url,
    });
    setDrawerOpen(true);
  }

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-4">
        <div className="flex gap-2">
          {["all", "ai", "outlook"].map((type) => (
            <Button
              key={type}
              variant={filter === type ? "default" : "outline"}
              onClick={() => setFilter(type)}
            >
              {type === "all"
                ? "All"
                : type === "ai"
                ? "AI Bookings"
                : "Outlook Events"}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex gap-4 text-sm">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-indigo-500"></span> AI Booking
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-blue-500"></span> Outlook Event
          </span>
        </div>
      </div>

      {/* Calendar */}
      {loading ? (
        <p className="text-gray-400">Loading calendar…</p>
      ) : (
        <Card className="shadow-sm border border-gray-200 overflow-hidden rounded-2xl">
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
            eventClick={handleEventClick}
            eventDisplay="block"
            eventBorderColor="transparent"
            dayMaxEvents={3}
            nowIndicator={true}
            slotEventOverlap={false}
          />
        </Card>
      )}

      {/* Drawer Panel */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerContent>
          {selectedEvent && (
            <div className="p-6">
              <DrawerHeader>
                <DrawerTitle>{selectedEvent.title}</DrawerTitle>
                <DrawerDescription>
                  {selectedEvent.source === "ai"
                    ? "AI Booking"
                    : "Outlook Calendar Event"}
                </DrawerDescription>
              </DrawerHeader>

              <div className="space-y-3 text-gray-700">
                <p>
                  <strong>When:</strong>{" "}
                  {new Date(selectedEvent.start).toLocaleString()}
                </p>
                {selectedEvent.location && (
                  <p>
                    <strong>Location:</strong> {selectedEvent.location}
                  </p>
                )}
                {selectedEvent.phone && (
                  <p>
                    <strong>Lead Phone:</strong> {selectedEvent.phone}
                  </p>
                )}
                {selectedEvent.attendees?.length > 0 && (
                  <p>
                    <strong>Attendees:</strong>{" "}
                    {selectedEvent.attendees.join(", ")}
                  </p>
                )}
              </div>

              {selectedEvent.url && (
                <div className="mt-6">
                  <Button
                    onClick={() => window.open(selectedEvent.url, "_blank")}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    Open in Outlook
                  </Button>
                </div>
              )}
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
