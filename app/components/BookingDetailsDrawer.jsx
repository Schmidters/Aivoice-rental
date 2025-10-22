"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

export default function BookingDetailsDrawer({ booking, open, onClose }) {
  if (!booking) return null;

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="right" className="w-[380px]">
        <SheetHeader>
          <SheetTitle>Viewing Details</SheetTitle>
          <SheetDescription>
            Detailed info for this showing.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4 text-sm">
          <p><strong>Property:</strong> {booking.propertyName}</p>
          <p><strong>Unit:</strong> {booking.unitType || "N/A"}</p>
          <p><strong>Lead Name:</strong> {booking.leadName}</p>
          <p><strong>Phone:</strong> {booking.phone}</p>
          <p><strong>Notes:</strong> {booking.notes || "No notes"}</p>
          <p><strong>Time:</strong> {new Date(booking.start).toLocaleString()}</p>
        </div>

        <div className="mt-6 flex gap-2">
          <Button className="w-full">Mark Complete</Button>
          <Button variant="outline" className="w-full" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
