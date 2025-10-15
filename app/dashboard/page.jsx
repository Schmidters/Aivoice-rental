"use client";

import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  // --- Fetch initial bookings from backend ---
  async function fetchBookings() {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/bookings`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data.ok) setBookings(data.items);
    } catch (err) {
      console.error("Error fetching bookings:", err);
    } finally {
      setLoading(false);
    }
  }

  // --- Subscribe to live booking events (SSE) ---
  useEffect(() => {
    fetchBookings();

    const evtSource = new EventSource(
      `${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/bookings/events`
    );

    evtSource.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data);
        setBookings((prev) => [b, ...prev]);
      } catch (err) {
        console.warn("SSE parse error:", err);
      }
    };

    return () => evtSource.close();
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Dashboard</h1>
      <p className="text-gray-600 mb-6">
        Overview of all recent AI bookings from Postgres.
      </p>

      {loading ? (
        <p className="text-gray-400">Loading bookings...</p>
      ) : bookings.length === 0 ? (
        <p className="text-gray-400">No bookings found yet.</p>
      ) : (
        <div className="grid gap-4">
          {bookings.map((b) => (
            <div
              key={b.id}
              className="p-4 rounded-xl shadow bg-white border border-gray-100 hover:shadow-md transition"
            >
              <div className="flex justify-between items-center mb-1">
                <span className="font-semibold text-gray-800">
                  {b.property || "Unknown property"}
                </span>
                <span className="text-sm text-gray-500">
                  {new Date(b.datetime).toLocaleString()}
                </span>
              </div>
              <p className="text-gray-700">
                📱 {b.phone} <span className="text-gray-400">({b.source})</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
