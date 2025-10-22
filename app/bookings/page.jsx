"use client";

import React, { useState, useEffect } from "react";
import { Calendar, momentLocalizer } from "react-big-calendar";
import moment from "moment";
import "react-big-calendar/lib/css/react-big-calendar.css";
import CalendarSettings from "@/components/CalendarSettings";
import BookingDetailsDrawer from "@/components/BookingDetailsDrawer";
import { Button } from "@/components/ui/button";
import AddBookingModal from "@/components/AddBookingModal";
import ReactTooltip from "react-tooltip";

const localizer = momentLocalizer(moment);
const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function BookingsPage() {
  console.log("[BookingsPage] ▶️ Rendering start");

  const [events, setEvents] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openHours, setOpenHours] = useState({ openStart: "08:00", openEnd: "17:00" });
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);

  // --- Log each render state
  console.log("[BookingsPage] State snapshot:", {
    settingsOpen,
    openHours,
    selectedBooking,
    drawerOpen,
    addModalOpen,
    eventsCount: events.length,
  });

  async function loadBookings() {
    try {
      const res = await fetch(`${BACKEND}/api/bookings`);
      const data = await res.json();
      if (data.ok) setEvents(data.data);
      console.log("[BookingsPage] ✅ Loaded bookings:", data.data?.length);
    } catch (err) {
      console.error("[BookingsPage] ❌ Error loading bookings:", err);
    }
  }

  useEffect(() => {
    async function loadAvailability() {
      try {
        const res = await fetch(`${BACKEND}/api/availability`);
        const json = await res.json();
        if (json.ok && json.data) {
  let hours;
  if (Array.isArray(json.data)) {
    console.warn("[BookingsPage] ℹ️ Availability returned an array, normalizing...");
    // You can later use this data for blocked time logic
    hours = { openStart: "08:00", openEnd: "17:00" }; // fallback
  } else {
    hours = json.data;
  }
  setOpenHours(hours);
  console.log("[BookingsPage] ✅ Loaded normalized openHours:", hours);
} else {
  console.warn("[BookingsPage] ⚠️ Missing openHours data:", json);
}

      } catch (err) {
        console.error("[BookingsPage] ❌ Error loading availability:", err);
      }
    }

    loadBookings();
    loadAvailability();
  }, []);

  // Helper to generate "closed" events outside per-day open hours
const generateBlockedHours = () => {
  const blocks = [];

  // Fallback global defaults
  const defaultStart = openHours?.openStart || "08:00";
  const defaultEnd = openHours?.openEnd || "17:00";

  // Try to use per-day settings if present
  const dayHours = {
    0: { start: openHours?.sundayStart || defaultStart, end: openHours?.sundayEnd || defaultEnd },
    1: { start: openHours?.mondayStart || defaultStart, end: openHours?.mondayEnd || defaultEnd },
    2: { start: openHours?.tuesdayStart || defaultStart, end: openHours?.tuesdayEnd || defaultEnd },
    3: { start: openHours?.wednesdayStart || defaultStart, end: openHours?.wednesdayEnd || defaultEnd },
    4: { start: openHours?.thursdayStart || defaultStart, end: openHours?.thursdayEnd || defaultEnd },
    5: { start: openHours?.fridayStart || defaultStart, end: openHours?.fridayEnd || defaultEnd },
    6: { start: openHours?.saturdayStart || defaultStart, end: openHours?.saturdayEnd || defaultEnd },
  };

  const today = moment().startOf("week");

  // Generate for 90 days (≈3 months)
  for (let i = 0; i < 90; i++) {
    const day = today.clone().add(i, "days");
    const dow = day.day(); // 0 = Sunday ... 6 = Saturday
    const { start, end } = dayHours[dow];

    const [openH, openM] = start.split(":").map(Number);
    const [closeH, closeM] = end.split(":").map(Number);

    // Skip “closed all day” (start=end=00:00)
    if (start === "00:00" && end === "00:00") {
      blocks.push({
        title: "Closed All Day",
        start: day.clone().startOf("day").toDate(),
        end: day.clone().endOf("day").toDate(),
        allDay: true,
        color: "#e5e7eb", // gray-200
        type: "closed",
      });
      continue;
    }

    // Closed before opening
    blocks.push({
      title: "Closed",
      start: day.clone().hour(0).minute(0).toDate(),
      end: day.clone().hour(openH).minute(openM).toDate(),
      allDay: false,
      color: "#d1d5db", // gray-300
      type: "closed",
    });

    // Closed after closing
    blocks.push({
      title: "Closed",
      start: day.clone().hour(closeH).minute(closeM).toDate(),
      end: day.clone().hour(23).minute(59).toDate(),
      allDay: false,
      color: "#d1d5db",
      type: "closed",
    });
  }

  return blocks;
};



  const allEvents = [...events, ...generateBlockedHours()];

  console.log("[BookingsPage] 📅 total events (including blocked):", allEvents.length);

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold">Showings & Availability</h1>
          <p className="text-sm text-gray-500">Manage your booked showings and open hours</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => {
            console.log("[BookingsPage] 🧭 Opening CalendarSettings");
            setSettingsOpen(true);
          }}>
            Calendar Settings
          </Button>
          <Button onClick={() => {
            console.log("[BookingsPage] ➕ Opening AddBookingModal");
            setAddModalOpen(true);
          }}>
            + Add Showing
          </Button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-4 text-sm text-gray-600">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 bg-indigo-600 rounded-sm"></span> Showing
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 bg-red-600 rounded-sm"></span> Blocked
        </div>
      </div>

      <Calendar
        localizer={localizer}
        events={allEvents}
        startAccessor="start"
        endAccessor="end"
        style={{ height: "80vh" }}
        eventPropGetter={(event) => ({
  style: {
    backgroundColor:
      event.type === "closed" ? "#d1d5db" : "#4f46e5", // light gray vs indigo
    color: event.type === "closed" ? "#374151" : "white",
    opacity: 0.9,
    borderRadius: "6px",
    border: event.type === "closed" ? "1px solid #9ca3af" : "none",
  },
})}

        onSelectEvent={(event) => {
          console.log("[BookingsPage] 🖱️ Selected event:", event);
          if (event.type !== "blocked") {
            setSelectedBooking(event);
            setDrawerOpen(true);
          }
        }}
      />

      <CalendarSettings
  open={settingsOpen}
  onClose={() => {
    console.log("[BookingsPage] 🔒 Closing CalendarSettings");
    setSettingsOpen(false);
  }}
  onSave={async (settings) => {
    console.log("[BookingsPage] 💾 Saving openHours:", settings);
    try {
      await fetch(`${BACKEND}/api/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      setOpenHours(settings);
      setSettingsOpen(false);
    } catch (err) {
      console.error("[BookingsPage] ❌ Failed to save open hours:", err);
    }
  }}
  defaults={openHours}
/>


      <BookingDetailsDrawer
        open={drawerOpen}
        onClose={() => {
          console.log("[BookingsPage] 🔒 Closing BookingDetailsDrawer");
          setDrawerOpen(false);
        }}
        booking={selectedBooking}
      />

      <AddBookingModal
        open={addModalOpen}
        onClose={() => {
          console.log("[BookingsPage] 🔒 Closing AddBookingModal");
          setAddModalOpen(false);
        }}
        onSave={async (form) => {
          console.log("[BookingsPage] 💾 Adding booking:", form);
          try {
            const res = await fetch(`${BACKEND}/api/bookings`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(form),
            });
            if (res.ok) {
              loadBookings();
              setAddModalOpen(false);
            }
          } catch (err) {
            console.error("[BookingsPage] ❌ Failed to add booking:", err);
          }
        }}
      />
    </div>
  );
}
