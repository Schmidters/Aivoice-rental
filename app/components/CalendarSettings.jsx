"use client";

import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function CalendarSettings({ open, onClose, onSave, defaults }) {
  const defaultTimes = {
    mondayStart: "08:00", mondayEnd: "17:00",
    tuesdayStart: "08:00", tuesdayEnd: "17:00",
    wednesdayStart: "08:00", wednesdayEnd: "17:00",
    thursdayStart: "08:00", thursdayEnd: "17:00",
    fridayStart: "08:00", fridayEnd: "17:00",
    saturdayStart: "10:00", saturdayEnd: "14:00",
    sundayStart: "00:00", sundayEnd: "00:00",
  };

  const [form, setForm] = useState(defaultTimes);

  // 🔄 Load defaults from backend
  useEffect(() => {
    if (defaults?.days) {
      const newForm = {};
      for (const [day, value] of Object.entries(defaults.days)) {
        newForm[`${day}Start`] = value.start;
        newForm[`${day}End`] = value.end;
      }
      setForm((prev) => ({ ...prev, ...newForm }));
    }
  }, [defaults]);

  const handleChange = (day, key, value) => {
    setForm((prev) => ({ ...prev, [`${day}${key}`]: value }));
  };

  const handleSave = () => {
    const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
      .reduce((acc, day) => ({
        ...acc,
        [day]: {
          start: form[`${day}Start`],
          end: form[`${day}End`],
        },
      }), {});
    console.log("[CalendarSettings] 💾 Saving per-day form:", days);
    onSave({ days });
  };

  const copyMondayToAll = () => {
    setForm((prev) => {
      const { mondayStart, mondayEnd } = prev;
      const updated = { ...prev };
      [
        "tuesday","wednesday","thursday","friday","saturday","sunday"
      ].forEach((day) => {
        updated[`${day}Start`] = mondayStart;
        updated[`${day}End`] = mondayEnd;
      });
      return updated;
    });
  };

  const resetDefaults = () => {
    setForm(defaultTimes);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-white rounded-lg shadow-xl p-6">
        <DialogHeader>
          <DialogTitle>Calendar Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          <div className="grid grid-cols-3 text-sm font-semibold text-gray-600 border-b pb-2">
            <span>Day</span>
            <span>Open</span>
            <span>Close</span>
          </div>

          {[
            "monday","tuesday","wednesday","thursday","friday","saturday","sunday"
          ].map((day) => (
            <div
              key={day}
              className="grid grid-cols-3 items-center gap-3 border-b py-2 text-sm"
            >
              <span className="capitalize">{day}</span>
              <Input
                type="time"
                value={form[`${day}Start`]}
                onChange={(e) => handleChange(day, "Start", e.target.value)}
                className="w-28"
              />
              <Input
                type="time"
                value={form[`${day}End`]}
                onChange={(e) => handleChange(day, "End", e.target.value)}
                className="w-28"
              />
            </div>
          ))}
        </div>

        {/* Utility Buttons */}
        <div className="flex justify-between mt-5">
          <Button
            variant="outline"
            onClick={copyMondayToAll}
            className="text-sm border-gray-300 hover:bg-gray-100"
          >
            Copy Monday to All
          </Button>
          <Button
            variant="outline"
            onClick={resetDefaults}
            className="text-sm border-gray-300 hover:bg-gray-100"
          >
            Reset Defaults
          </Button>
        </div>

        <DialogFooter className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
