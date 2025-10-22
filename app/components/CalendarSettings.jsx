"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function CalendarSettings({ open, onClose, onSave, defaults }) {
  const [start, setStart] = useState(defaults?.openStart || "08:00");
  const [end, setEnd] = useState(defaults?.openEnd || "17:00");

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Calendar Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Open From</Label>
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <Label>Open Until</Label>
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ openStart: start, openEnd: end })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
