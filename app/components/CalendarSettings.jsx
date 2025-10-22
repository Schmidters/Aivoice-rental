"use client";

import React, { useState, useEffect } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function CalendarSettings({ open, onClose, onSave, defaults }) {
  const [openStart, setOpenStart] = useState(defaults?.openStart || "08:00");
  const [openEnd, setOpenEnd] = useState(defaults?.openEnd || "17:00");

  useEffect(() => {
    if (defaults) {
      setOpenStart(defaults.openStart || "08:00");
      setOpenEnd(defaults.openEnd || "17:00");
    }
  }, [defaults]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <div className="fixed inset-0 flex items-center justify-center bg-black/30">
        <div className="bg-white dark:bg-gray-900 rounded-lg p-6 shadow-xl w-96">
          <h2 className="text-lg font-semibold mb-4">Calendar Settings</h2>

          <div className="space-y-4">
            <div>
              <Label>Open Time</Label>
              <Input
                type="time"
                value={openStart}
                onChange={(e) => setOpenStart(e.target.value)}
                className="w-full mt-1"
              />
            </div>

            <div>
              <Label>Close Time</Label>
              <Input
                type="time"
                value={openEnd}
                onChange={(e) => setOpenEnd(e.target.value)}
                className="w-full mt-1"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => onSave({ openStart, openEnd })}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
