"use client";

import UnifiedCalendar from "@/components/UnifiedCalendar";

export default function DashboardPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold mb-2">Dashboard</h1>
        <p className="text-gray-600">
          Unified calendar view combining AI Bookings + Outlook Events.
        </p>
      </div>

      {/* 🗓️ Read-only unified calendar */}
      <UnifiedCalendar />
    </div>
  );
}
