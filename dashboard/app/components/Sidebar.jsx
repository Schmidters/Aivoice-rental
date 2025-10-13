"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Users, MessageCircle, Calendar, FileText } from "lucide-react";
import clsx from "clsx";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: Home },
  { name: "Leads", href: "/leads", icon: Users },
  { name: "Conversations", href: "/conversations", icon: MessageCircle },
  { name: "Bookings", href: "/bookings", icon: Calendar },
  { name: "Logs", href: "/logs", icon: FileText },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="h-screen w-64 bg-gray-900 text-white flex flex-col border-r border-gray-800">
      <div className="px-6 py-4 text-2xl font-semibold tracking-tight border-b border-gray-800">
        AI Leasing
      </div>
      <nav className="flex-1 mt-4 space-y-1">
        {navItems.map(({ name, href, icon: Icon }) => (
          <Link
            key={name}
            href={href}
            className={clsx(
              "flex items-center px-6 py-3 text-sm font-medium hover:bg-gray-800 transition-colors",
              pathname.startsWith(href)
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:text-white"
            )}
          >
            <Icon className="mr-3 h-4 w-4" />
            {name}
          </Link>
        ))}
      </nav>
    </div>
  );
}
