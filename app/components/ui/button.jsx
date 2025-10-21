"use client";

export function Button({ children, onClick, variant = "solid", className = "" }) {
  const base = "rounded-md px-4 py-2 text-sm font-medium transition focus:outline-none";
  const styles =
    variant === "outline"
      ? "border border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200"
      : "bg-indigo-600 text-white hover:bg-indigo-700";

  return (
    <button onClick={onClick} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}
