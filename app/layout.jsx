import './globals.css';
import Sidebar from '@/components/Sidebar';

export const metadata = {
  title: 'AI Leasing Dashboard',
  description: 'Ops dashboard',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <div className="flex min-h-screen">
          {/* left */}
          <Sidebar />

          {/* right / main */}
          <main className="flex-1 p-6">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
