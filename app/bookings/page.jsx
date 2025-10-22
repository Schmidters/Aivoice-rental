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
    const d = json.data.days || {};
    hours = {
      ...json.data,
      mondayStart: d.monday?.start,
      mondayEnd: d.monday?.end,
      tuesdayStart: d.tuesday?.start,
      tuesdayEnd: d.tuesday?.end,
      wednesdayStart: d.wednesday?.start,
      wednesdayEnd: d.wednesday?.end,
      thursdayStart: d.thursday?.start,
      thursdayEnd: d.thursday?.end,
      fridayStart: d.friday?.start,
      fridayEnd: d.friday?.end,
      saturdayStart: d.saturday?.start,
      saturdayEnd: d.saturday?.end,
      sundayStart: d.sunday?.start,
      sundayEnd: d.sunday?.end,
    };
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

    // 🔁 Listen for global availability update events (e.g., when settings are saved)
  useEffect(() => {
    function refreshAvailability() {
      console.log("[BookingsPage] 🔄 Refreshing availability due to external update");
      fetch(`${BACKEND}/api/availability`)
        .then((r) => r.json())
        .then((json) => {
          if (json.ok) {
            setOpenHours(json.data);
            console.log("[BookingsPage] ✅ Updated openHours:", json.data);
          }
        })
        .catch((err) => console.error("[BookingsPage] ❌ Failed refreshing availability:", err));
    }

    window.addEventListener("availabilityUpdated", refreshAvailability);
    return () => window.removeEventListener("availabilityUpdated", refreshAvailability);
  }, []);


  // Helper to generate "closed" events outside per-day open hours
// Helper to generate "closed" events outside per-day open hours
const generateBlockedHours = () => {
  const blocks = [];

  // Fallback global defaults
  const defaultStart = openHours?.openStart || "08:00";
  const defaultEnd = openHours?.openEnd || "17:00";

  // ✅ Pull from nested days if present
  const days = openHours?.days || {};
  const dayHours = {
    0: days.sunday || { start: defaultStart, end: defaultEnd },
    1: days.monday || { start: defaultStart, end: defaultEnd },
    2: days.tuesday || { start: defaultStart, end: defaultEnd },
    3: days.wednesday || { start: defaultStart, end: defaultEnd },
    4: days.thursday || { start: defaultStart, end: defaultEnd },
    5: days.friday || { start: defaultStart, end: defaultEnd },
    6: days.saturday || { start: defaultStart, end: defaultEnd },
  };

  const today = moment().startOf("week");

  for (let i = 0; i < 90; i++) {
    const day = today.clone().add(i, "days");
    const dow = day.day();
    const { start, end } = dayHours[dow];

    const [openH, openM] = start.split(":").map(Number);
    const [closeH, closeM] = end.split(":").map(Number);

    if (start === "00:00" && end === "00:00") {
      blocks.push({
        title: "Closed All Day",
        start: day.clone().startOf("day").toDate(),
        end: day.clone().endOf("day").toDate(),
        allDay: true,
        color: "#e5e7eb",
        type: "closed",
      });
      continue;
    }

    blocks.push({
      title: "Closed",
      start: day.clone().hour(0).minute(0).toDate(),
      end: day.clone().hour(openH).minute(openM).toDate(),
      color: "#d1d5db",
      type: "closed",
    });

    blocks.push({
      title: "Closed",
      start: day.clone().hour(closeH).minute(closeM).toDate(),
      end: day.clone().hour(23).minute(59).toDate(),
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

    // 🔁 Trigger dashboard-wide refresh so BookingsPage updates immediately
    window.dispatchEvent(new Event("availabilityUpdated"));
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
