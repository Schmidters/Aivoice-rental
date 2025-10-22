"use client";

import React, { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function CalendarSettings({ open, onClose, onSave, defaults }) {
  const [form, setForm] = useState({ openStart: "08:00", openEnd: "17:00" });

  // 🔄 Whenever defaults change (from DB or props), sync local form
  useEffect(() => {
    if (defaults) setForm(defaults);
  }, [defaults]);

  // 🧠 Safety check logs
  useEffect(() => {
    console.log("[CalendarSettings] open =", open);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm bg-white rounded-lg shadow-lg p-6">
        <DialogHeader>
          <DialogTitle>Calendar Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Open Time</label>
            <Input
              type="time"
              value={form.openStart}
              onChange={(e) => setForm({ ...form, openStart: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Close Time</label>
            <Input
              type="time"
              value={form.openEnd}
              onChange={(e) => setForm({ ...form, openEnd: e.target.value })}
            />
          </div>
        </div>

        <DialogFooter className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              console.log("[CalendarSettings] 💾 Saving form", form);
              onSave(form);
            }}
            className="bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
