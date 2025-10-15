'use client';

import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, parseISO } from 'date-fns';
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

export default function BookingsCalendar() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    // Use env var if set; hard-fallback to your backend so it never 404s
    const backendBase =
      process.env.NEXT_PUBLIC_AI_BACKEND_URL || 'https://aivoice-rental.onrender.com';

    async function load() {
      const url = `${backendBase}/bookings`; // ✅ correct backend route (no /api)
      console.log('➡️ Fetching bookings:', url);
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const j = await r.json();
        if (!j?.ok) {
          console.warn('Bookings load failed:', j);
          return;
        }

        // Backend returns: { ok: true, bookings: [{ phone, property, datetime }, ...] }
        const normalized = (j.bookings || [])
          .map((b) => {
            if (!b?.datetime) return null;
            const start = parseISO(b.datetime);
            return {
              title: `${b.property || 'Unknown property'} (${b.phone || ''})`,
              start,
              end: start, // you can extend to +30min later if you like
              allDay: false,
            };
          })
          .filter(Boolean);

        console.log(`✅ Loaded ${normalized.length} bookings`);
        setEvents(normalized);
      } catch (err) {
        console.error('Error loading bookings:', err);
      }
    }

    load();

    // Live updates via SSE from backend
    const esUrl = `${backendBase}/events/bookings`; // ✅ correct SSE route (no /api)
    console.log('🔗 Connecting to SSE:', esUrl);
    const es = new EventSource(esUrl);

    es.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data); // { phone, property, datetime }
        if (!b?.datetime) return;
        const start = parseISO(b.datetime);
        const evt = {
          title: `${b.property || 'Unknown property'} (${b.phone || ''})`,
          start,
          end: start,
          allDay: false,
        };
        console.log('📩 Live booking received:', evt);
        setEvents((prev) => [evt, ...prev]);
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    es.onerror = (err) => {
      console.warn('⚠️ SSE connection error:', err);
    };

    return () => es.close();
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
