"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils"; // if you don’t have this util, I’ll add it next

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: "🏠" },
  { href: "/inbox", label: "Inbox", icon: "💬" },
  { href: "/bookings", label: "Bookings", icon: "📅" },
  { href: "/properties", label: "Properties", icon: "🏘️" },
  { href: "/analytics", label: "Analytics", icon: "📊" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 flex-none border-r bg-white/90 p-3 md:block">
      <div className="mb-4 px-2 text-lg font-semibold tracking-tight">
        Ava Rental Assistant
      </div>
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-gray-900 text-white"
                  : "text-gray-700 hover:bg-gray-100"
              )}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
