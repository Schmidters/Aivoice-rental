"use client";

import * as React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export function Sheet({ open, onOpenChange, children }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  );
}

export function SheetContent({ children, side = "right", className = "" }) {
  const sideClass = side === "right"
    ? "fixed right-0 top-0 h-full w-80 bg-white dark:bg-gray-900 shadow-lg p-6 overflow-y-auto"
    : "fixed left-0 top-0 h-full w-80 bg-white dark:bg-gray-900 shadow-lg p-6 overflow-y-auto";

  return <DialogContent className={`${sideClass} ${className}`}>{children}</DialogContent>;
}

export function SheetHeader({ children }) {
  return <div className="mb-4">{children}</div>;
}

export function SheetTitle({ children }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

export function SheetDescription({ children }) {
  return <p className="text-sm text-gray-500">{children}</p>;
}
