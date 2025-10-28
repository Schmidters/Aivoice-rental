"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

export function ScrollArea({ children, className, ...props }) {
  return (
    <ScrollAreaPrimitive.Root className={`overflow-hidden ${className || ""}`} {...props}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex select-none touch-none p-0.5 transition-colors"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-gray-300 hover:bg-gray-400" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}
