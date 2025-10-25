import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata = {
  title: "Ava Leasing Dashboard",
  description: "AI-powered rental assistant dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen bg-gray-50 text-gray-900">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </body>
    </html>
  );
}
