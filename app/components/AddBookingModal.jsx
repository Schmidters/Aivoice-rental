"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export default function AddBookingModal({ open, onClose, onSave }) {
  const [form, setForm] = useState({
    propertyName: "",
    unitType: "",
    leadName: "",
    phone: "",
    notes: "",
    start: "",
    end: "",
  });

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Showing</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Property</Label>
            <Input name="propertyName" value={form.propertyName} onChange={handleChange} />
          </div>
          <div>
            <Label>Unit Type</Label>
            <Input name="unitType" value={form.unitType} onChange={handleChange} />
          </div>
          <div>
            <Label>Lead Name</Label>
            <Input name="leadName" value={form.leadName} onChange={handleChange} />
          </div>
          <div>
            <Label>Phone</Label>
            <Input name="phone" value={form.phone} onChange={handleChange} />
          </div>
          <div>
            <Label>Notes</Label>
            <Input name="notes" value={form.notes} onChange={handleChange} />
          </div>
          <div className="flex gap-2">
            <div className="w-1/2">
              <Label>Start</Label>
              <Input type="datetime-local" name="start" value={form.start} onChange={handleChange} />
            </div>
            <div className="w-1/2">
              <Label>End</Label>
              <Input type="datetime-local" name="end" value={form.end} onChange={handleChange} />
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(form)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
