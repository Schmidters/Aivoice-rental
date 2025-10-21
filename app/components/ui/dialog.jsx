"use client";
import * as DialogPrimitive from "@radix-ui/react-dialog";

export function Dialog({ open, onOpenChange, children }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>{children}</DialogPrimitive.Root>;
}

export function DialogContent({ children, className }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-black/50 z-40" />
      <DialogPrimitive.Content
        className={`fixed z-50 bg-white dark:bg-gray-900 rounded-lg shadow-lg p-6 w-[90%] max-w-md top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${className}`}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children }) {
  return <div className="mb-4">{children}</div>;
}

export function DialogTitle({ children }) {
  return <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{children}</h2>;
}
