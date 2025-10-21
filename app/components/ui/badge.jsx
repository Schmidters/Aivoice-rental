import * as React from "react";

// Simple local fallback for className merging
function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

export function Badge({ className, children }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        "bg-gray-100 text-gray-800 border-gray-200",
        "dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700",
        className
      )}
    >
      {children}
    </span>
  );
}

export default Badge;
