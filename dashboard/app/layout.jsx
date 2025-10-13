import "./globals.css";

export const metadata = {
  title: "AI Leasing Dashboard",
  description: "Manage AI rental leads and leasing conversations.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
