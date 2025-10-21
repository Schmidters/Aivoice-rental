"use client";

import { useEffect, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import enUS from "date-fns/locale/en-US";
import "react-big-calendar/lib/css/react-big-calendar.css";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

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
  const [modalOpen, setModalOpen] = useState(false);
  const [newSlot, setNewSlot] = useState(null);
  const [isBlocked, setIsBlocked] = useState(false);
  const [notes, setNotes] = useState("");

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

      const bookingEvents = bookings.map((b) => ({
        id: `booking-${b.id}`,
        title: `Showing: ${b.property?.facts?.buildingName || b.property?.address || "Unit"} (${b.lead?.phone})`,
        start: new Date(b.datetime),
        end: new Date(new Date(b.datetime).getTime() + (b.duration || 30) * 60000),
        allDay: false,
        type: "booking",
      }));

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
    const es = new EventSource(`${BACKEND}/api/bookings/events`);
    es.onmessage = () => loadAll();
    return () => es.close();
  }, []);

  function handleSelectSlot(slotInfo) {
    setNewSlot(slotInfo);
    setModalOpen(true);
  }

  async function handleSave() {
    if (!newSlot) return;
    const { start, end } = newSlot;

    const res = await fetch(`${BACKEND}/api/availability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        propertySlug: "215-16-street-southeast",
        startTime: start,
        endTime: end,
        isBlocked,
        notes,
      }),
    });

    const j = await res.json();
    if (j.ok) {
      setModalOpen(false);
      setNotes("");
      setIsBlocked(false);
      await loadAll();
    } else {
      alert("❌ Failed to save: " + j.error);
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

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Add Time Slot</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="status">Type:</Label>
              <select
                id="status"
                className="border rounded p-2 w-full bg-gray-50 dark:bg-gray-800"
                value={isBlocked ? "blocked" : "available"}
                onChange={(e) => setIsBlocked(e.target.value === "blocked")}
              >
                <option value="available">Available</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g., Owner away, key pickup..."
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
