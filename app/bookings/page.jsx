'use client';

import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import { parseISO } from 'date-fns';
import 'react-big-calendar/lib/css/react-big-calendar.css';

// --- Calendar localization setup ---
const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales,
});

export default function BookingsCalendar() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    async function load() {
      try {
        const base = (process.env.NEXT_PUBLIC_AI_BACKEND_URL || '').replace(/\/$/, '');
        if (!base) {
          console.warn('Missing NEXT_PUBLIC_AI_BACKEND_URL');
          return;
        }

        // Fetch initial bookings
        const r = await fetch(`${base}/api/bookings`, { cache: 'no-store' });
        const j = await r.json();
        if (!j?.ok) return;

        const normalized = (j.items || []).map((b) => ({
          id: b.id,
          title: `${b.property} (${b.phone})`,
          // Use Date() to preserve local timezone
          start: new Date(b.datetime),
          end: new Date(b.datetime),
          allDay: false,
        }));

        setEvents(normalized);

        // --- Subscribe to live updates from backend SSE ---
        const es = new EventSource(`${base}/api/bookings/events`);
        es.onmessage = (e) => {
          try {
            const b = JSON.parse(e.data);
            const evt = {
              id: b.id,
              title: `${b.property} (${b.phone})`,
              start: new Date(b.datetime),
              end: new Date(b.datetime),
              allDay: false,
            };
            setEvents((prev) => [evt, ...prev]);
          } catch (err) {
            console.warn('Bad SSE message', err);
          }
        };

        es.onerror = (err) => console.error('SSE connection error', err);

        // Cleanup on unmount
        return () => es.close();
      } catch (err) {
        console.error('Failed to load bookings:', err);
      }
    }

    load();
  }, []);

  return (
    <div className="p-6 h-[calc(100vh-80px)] bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          📅 Showings Calendar
        </h1>
        <span className="text-sm text-gray-500">
          Total: {events.length} bookings
        </span>
      </div>

      <Calendar
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        style={{ height: 'calc(100vh - 160px)' }}
        eventPropGetter={() => ({
          style: {
            backgroundColor: '#4F46E5',
            borderRadius: '6px',
            color: 'white',
            border: 'none',
            padding: '2px 4px',
          },
        })}
      />
    </div>
  );
}
