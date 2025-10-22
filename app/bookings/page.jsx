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
  const [events, setEvents] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openHours, setOpenHours] = useState({ openStart: "08:00", openEnd: "17:00" });
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);


  async function loadBookings() {
    try {
      const res = await fetch(`${BACKEND}/api/bookings`);
      const data = await res.json();
      if (data.ok) setEvents(data.data);
    } catch (err) {
      console.error("Error loading bookings:", err);
    }
  }

  useEffect(() => {
  async function loadAvailability() {
    try {
      const res = await fetch(`${BACKEND}/api/availability`);
      const json = await res.json();
      if (json.ok && json.data) setOpenHours(json.data);
    } catch (err) {
      console.error("Error loading availability:", err);
    }
  }

  loadBookings();
  loadAvailability();
}, []);


  // Helper to generate "blocked" events outside open hours
  const generateBlockedHours = () => {
  const blocks = [];

  // 🧠 Fallback defaults if openHours is not yet loaded
  const start = openHours?.openStart || "08:00";
  const end = openHours?.openEnd || "17:00";

  const [openH, openM] = start.split(":").map(Number);
  const [closeH, closeM] = end.split(":").map(Number);

  const today = moment().startOf("week");
  for (let i = 0; i < 7; i++) {
    const day = today.clone().add(i, "days");
    blocks.push({
      title: "Blocked",
      start: day.clone().hour(0).minute(0).toDate(),
      end: day.clone().hour(openH).minute(openM).toDate(),
      allDay: false,
      color: "red",
      type: "blocked",
    });
    blocks.push({
      title: "Blocked",
      start: day.clone().hour(closeH).minute(closeM).toDate(),
      end: day.clone().hour(23).minute(59).toDate(),
      allDay: false,
      color: "red",
      type: "blocked",
    });
  }
  return blocks;
};


  const allEvents = [...events, ...generateBlockedHours()];

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
  <div>
    <h1 className="text-xl font-semibold">Showings & Availability</h1>
    <p className="text-sm text-gray-500">Manage your booked showings and open hours</p>
  </div>
  <div className="flex gap-2">
    <Button variant="outline" onClick={() => setSettingsOpen(true)}>Calendar Settings</Button>
    <Button onClick={() => setAddModalOpen(true)}>+ Add Showing</Button>
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
            backgroundColor: event.type === "blocked" ? "#dc2626" : "#4f46e5",
            opacity: event.type === "blocked" ? 0.8 : 1,
          },
        })}
        onSelectEvent={(event) => {
          if (event.type !== "blocked") {
            setSelectedBooking(event);
            setDrawerOpen(true);
          }
        }}
      />

      <CalendarSettings
  open={settingsOpen}
  onClose={() => setSettingsOpen(false)}
  onSave={async (settings) => {
    try {
      await fetch(`${BACKEND}/api/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      setOpenHours(settings);
      setSettingsOpen(false);
    } catch (err) {
      console.error("Failed to save open hours:", err);
    }
  }}
  defaults={openHours}
/>


      <BookingDetailsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        booking={selectedBooking}
      />
      <AddBookingModal
  open={addModalOpen}
  onClose={() => setAddModalOpen(false)}
  onSave={async (form) => {
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
      console.error("Failed to add booking:", err);
    }
  }}
/>

    </div>
  );
}
