'use client';
import { useEffect, useState } from 'react';

export default function BookingsPage() {
  const [bookings, setBookings] = useState([]);

  useEffect(() => {
    // Initial load
    fetch('/api/bookings')
      .then(r => r.json())
      .then(j => j.ok && setBookings(j.bookings || []));

    // Live updates via SSE
    const es = new EventSource('/api/bookings/events');
    es.onmessage = (e) => {
      const b = JSON.parse(e.data);
      setBookings((prev) => [b, ...prev]);
    };
    es.addEventListener('ping', () => {});
    es.onerror = () => {};
    return () => es.close();
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Booked Showings</h1>
      <table className="min-w-full text-sm border">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-2 text-left border-b">Date / Time</th>
            <th className="p-2 text-left border-b">Property</th>
            <th className="p-2 text-left border-b">Lead Phone</th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b, i) => (
            <tr key={i} className="border-b">
              <td className="p-2">{new Date(b.datetime).toLocaleString()}</td>
              <td className="p-2">{b.property}</td>
              <td className="p-2">{b.phone}</td>
            </tr>
          ))}
          {!bookings.length && (
            <tr>
              <td colSpan={3} className="p-4 text-center text-gray-500">
                No bookings yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
