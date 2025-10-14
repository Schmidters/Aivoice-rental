'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  MessageSquare,
  PhoneCall,
  CalendarDays,
  BookOpenText,
  ListTree,
} from 'lucide-react';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/leads', label: 'Leads', icon: ListTree },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/bookings', label: 'Bookings', icon: CalendarDays },
  { href: '/logs', label: 'Logs', icon: BookOpenText },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <div className="h-14 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
        <span className="text-sm font-semibold tracking-wide text-gray-800 dark:text-gray-100">
          AI Leasing
        </span>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || (href !== '/' && pathname?.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition
                ${active
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-3 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-800">
        v1 • {new Date().getFullYear()}
      </div>
    </aside>
  );
}
