"use client";
import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function CalendarSettings({ open, onClose, onSave, defaults }) {
  const [days, setDays] = useState(defaults?.days || {});

  useEffect(() => {
    if (defaults?.days) setDays(defaults.days);
  }, [defaults]);

  const handleChange = (day, key, value) => {
    // Always store in HH:mm format (adds leading zero if needed)
    const normalized = value.padStart(5, "0");
    setDays((prev) => ({
      ...prev,
      [day]: { ...(prev[day] || {}), [key]: normalized },
    }));
  };

  const handleSave = () => {
    onSave({ days });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-[420px]">
        <h2 className="text-lg font-semibold mb-4">Calendar Settings</h2>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {Object.keys(days).map((day) => (
            <div
              key={day}
              className="flex items-center justify-between border-b border-gray-200 py-2"
            >
              <span className="capitalize w-24">{day}</span>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  step="900" // 15-minute increments
                  value={days[day]?.start || "08:00"}
                  onChange={(e) => handleChange(day, "start", e.target.value)}
                  className="border rounded px-2 py-1 text-sm w-28 focus:ring focus:ring-indigo-200"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="time"
                  step="900"
                  value={days[day]?.end || "17:00"}
                  onChange={(e) => handleChange(day, "end", e.target.value)}
                  className="border rounded px-2 py-1 text-sm w-28 focus:ring focus:ring-indigo-200"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </div>
    </div>
  );
}
