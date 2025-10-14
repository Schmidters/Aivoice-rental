// app/layout.jsx
import './globals.css';

export const metadata = {
  title: 'AI Leasing Dashboard',
  description: 'Ops dashboard',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="flex">
          {/* If you have a Sidebar component, render it here */}
          {/* <Sidebar /> */}
          <main className="flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
