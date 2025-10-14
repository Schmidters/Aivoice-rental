export function Card({ children, className }) {
  return <div className={`rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm ${className || ''}`}>{children}</div>;
}
export function CardHeader({ children }) {
  return <div className="border-b border-gray-200 dark:border-gray-800 p-4">{children}</div>;
}
export function CardTitle({ children }) {
  return <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{children}</h3>;
}
export function CardContent({ children }) {
  return <div className="p-4">{children}</div>;
}