"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Initialize from localStorage or system
    const saved = localStorage.getItem("theme");
    const preferDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldDark = saved ? saved === "dark" : preferDark;
    document.documentElement.classList.toggle("dark", shouldDark);
    setIsDark(shouldDark);
  }, []);

  const toggle = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-700"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <span className="h-2 w-2 rounded-full bg-gray-900 dark:bg-gray-100" />
      <span>{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
