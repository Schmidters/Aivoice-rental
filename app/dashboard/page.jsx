"use client";

import { useEffect, useState } from "react";

export default function DashboardPage() {
  const [bookings, setBookings] = useState([]);
  const [outlookEvents, setOutlookEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const BACKEND =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
    "https://aivoice-rental.onrender.com";

  // --- Fetch both AI bookings + Outlook events ---
  async function fetchAll() {
    try {
      const [bookingsRes, outlookRes] = await Promise.all([
        fetch(`${BACKEND}/api/bookings`, { cache: "no-store" }),
        fetch(`${BACKEND}/api/outlook-sync/events`, { cache: "no-store" }),
      ]);

      const [bookingsJson, outlookJson] = await Promise.all([
        bookingsRes.json(),
        outlookRes.json(),
      ]);

      // Normalize bookings from DB
      const normalizedBookings = (bookingsJson.data || bookingsJson.items || []).map(
        (b) => ({
          id: b.id,
          title: b.property?.address || "AI Showing",
          start: b.datetime,
          phone: b.lead?.phone || "Unknown",
          source: "manual",
        })
      );

      // Normalize Outlook events
      const normalizedOutlook = (outlookJson.data || []).map((evt) => ({
        id: evt.id,
        title: evt.title || "Outlook Event",
        start: evt.start,
        location: evt.location,
        source: "outlook",
        webLink: evt.webLink,
      }));

      setBookings(normalizedBookings);
      setOutlookEvents(normalizedOutlook);
    } catch (err) {
      console.error("❌ Error fetching events:", err);
    } finally {
      setLoading(false);
    }
  }

  // --- SSE for live AI bookings ---
  useEffect(() => {
    fetchAll();

    const evtSource = new EventSource(`${BACKEND}/api/bookings/events`);

    evtSource.onmessage = (e) => {
      try {
        const b = JSON.parse(e.data);
        setBookings((prev) => [
          {
            id: b.id,
            title: b.property || "AI Showing",
            start: b.datetime,
            phone: b.phone,
            source: "manual",
          },
          ...prev,
        ]);
      } catch (err) {
        console.warn("⚠️ SSE parse error:", err);
      }
    };

    return () => evtSource.close();
  }, []);

  const combined = [...bookings, ...outlookEvents].sort(
    (a, b) => new Date(b.start) - new Date(a.start)
  );

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Dashboard</h1>
      <p className="text-gray-600 mb-6">
        Unified view of all bookings — AI + Outlook Calendar.
      </p>

      {loading ? (
        <p className="text-gray-400">Loading events...</p>
      ) : combined.length === 0 ? (
        <p className="text-gray-400">No events found yet.</p>
      ) : (
        <div className="grid gap-4">
          {combined.map((evt) => (
            <div
              key={evt.id}
              className={`p-4 rounded-xl shadow border transition hover:shadow-md ${
                evt.source === "outlook"
                  ? "bg-blue-50 border-blue-200"
                  : "bg-white border-gray-100"
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <span className="font-semibold text-gray-800">
                  {evt.title}
                </span>
                <span className="text-sm text-gray-500">
                  {new Date(evt.start).toLocaleString()}
                </span>
              </div>

              {evt.source === "outlook" ? (
                <p className="text-blue-700 text-sm">
                  📅 Outlook Event{" "}
                  {evt.location && (
                    <span className="text-gray-500">({evt.location})</span>
                  )}
                  {evt.webLink && (
                    <a
                      href={evt.webLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 underline text-blue-500"
                    >
                      Open
                    </a>
                  )}
                </p>
              ) : (
                <p className="text-gray-700 text-sm">
                  📱 {evt.phone} <span className="text-gray-400">(AI)</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
