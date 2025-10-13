import "../globals.css";
import Sidebar from "@/dashboard/components/Sidebar";

export const metadata = {
  title: "AI Leasing Dashboard",
  description: "Track leads, bookings, and conversations",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex bg-gray-50 text-gray-900">
        <Sidebar />
        <main className="flex-1 min-h-screen overflow-y-auto p-6">{children}</main>
      </body>
    </html>
  );
}
