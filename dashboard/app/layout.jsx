export const metadata = {
  title: "AI Leasing Dashboard",
  description: "Clean analytics for your AI rental assistant",
};

import "../globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
