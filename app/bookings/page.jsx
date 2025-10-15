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

  // Load existing bookings from Redis
  useEffect(() => {
    async function load() {
      const r = await fetch('/api/bookings', { cache: 'no-store' });
      const j = await r.json();
      if (!j?.ok) return;
      const normalized = (j.items || []).map((b) => {
        const dt = b.data?.datetime || b.data?._list?.[0] || null;
        return dt
          ? {
              title: `${b.property || 'Unknown property'} (${b.phone || ''})`,
              start: parseISO(dt),
              end: parseISO(dt),
              allDay: false,
            }
          : null;
      }).filter(Boolean);
      setEvents(normalized);
    }
    load();

    // Live SSE updates
    const es = new EventSource('/api/bookings/events');
    es.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data);
        const evt = {
          title: `${b.property} (${b.phone})`,
          start: parseISO(b.datetime),
          end: parseISO(b.datetime),
          allDay: false,
        };
        setEvents((prev) => [evt, ...prev]);
      } catch {}
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
