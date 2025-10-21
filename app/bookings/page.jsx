'use client';

import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

const BACKEND =
  process.env.NEXT_PUBLIC_AI_BACKEND_URL || 'https://aivoice-rental.onrender.com';

export default function BookingsCalendar() {
  const [events, setEvents] = useState([]);

  async function loadData() {
    try {
      const [bookingsRes, availRes] = await Promise.all([
        fetch(`${BACKEND}/api/bookings`, { cache: 'no-store' }),
        fetch(`${BACKEND}/api/availability`, { cache: 'no-store' }),
      ]);
      const bookingsJson = await bookingsRes.json();
      const availabilityJson = await availRes.json();

      const bookings =
        bookingsJson?.data?.map((b) => ({
          id: `booking-${b.id}`,
          title: `Showing (${b.lead?.phone || 'Lead'})`,
          start: new Date(b.datetime),
          end: new Date(new Date(b.datetime).getTime() + (b.duration || 30) * 60000),
          bg:
            b.status === 'confirmed'
              ? '#4ade80'
              : b.status === 'pending'
              ? '#facc15'
              : '#f87171',
        })) || [];

      const blocks =
        availabilityJson?.data
          ?.filter((a) => a.isBlocked)
          .map((a) => ({
            id: `block-${a.id}`,
            title: 'Blocked',
            start: new Date(a.startTime),
            end: new Date(a.endTime),
            bg: '#9ca3af',
          })) || [];

      setEvents([...bookings, ...blocks]);
    } catch (err) {
      console.error('Failed to load bookings/availability:', err);
    }
  }

  useEffect(() => {
    loadData();

    const es = new EventSource(`${BACKEND}/api/availability/events`);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'created') {
          const a = msg.data;
          setEvents((prev) => [
            ...prev,
            {
              id: `block-${a.id}`,
              title: 'Blocked',
              start: new Date(a.startTime),
              end: new Date(a.endTime),
              bg: '#9ca3af',
            },
          ]);
        } else if (msg.type === 'deleted') {
          setEvents((prev) =>
            prev.filter((ev) => ev.id !== `block-${msg.data.id}`)
          );
        }
      } catch {}
    };
    es.onerror = (err) => console.error('SSE connection error', err);
    return () => es.close();
  }, []);

  // 🟣 Click-and-drag to block a slot
  async function handleSelectSlot({ start, end }) {
    const confirmBlock = window.confirm(
      `Block this time from ${start.toLocaleString()} to ${end.toLocaleString()}?`
    );
    if (!confirmBlock) return;

    const body = {
      propertySlug: '215-16-street-southeast', // Replace with dynamic later
      startTime: start,
      endTime: end,
      isBlocked: true,
    };

    const res = await fetch(`${BACKEND}/api/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!json.ok) alert('Failed to save block: ' + json.error);
  }

  // 🔴 Click a block to delete it
  async function handleSelectEvent(event) {
    if (!event.id.startsWith('block-')) return; // only delete gray blocks
    const confirmDelete = window.confirm(`Unblock this time slot?`);
    if (!confirmDelete) return;

    const id = event.id.replace('block-', '');
    const res = await fetch(`${BACKEND}/api/availability/${id}`, {
      method: 'DELETE',
    });
    const json = await res.json();
    if (!json.ok) alert('Failed to delete block: ' + json.error);
  }

  return (
    <div className="p-6 h-[calc(100vh-80px)] bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          📅 Showings Calendar
        </h1>
        <span className="text-sm text-gray-500">Total: {events.length} events</span>
      </div>

      <Calendar
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        selectable
        onSelectSlot={handleSelectSlot}
        onSelectEvent={handleSelectEvent}
        style={{ height: 'calc(100vh - 160px)' }}
        eventPropGetter={(event) => ({
          style: {
            backgroundColor: event.bg || '#4F46E5',
            borderRadius: '6px',
            color: 'white',
            border: 'none',
            padding: '2px 4px',
          },
        })}
        popup
      />
    </div>
  );
}
