export function Card({ children, className='' }) {
  return <div className={`rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm ${className}`}>{children}</div>;
}
export function CardHeader({ children }) { return <div className='border-b border-gray-200 dark:border-gray-700 px-5 py-4'>{children}</div>; }
export function CardTitle({ children }) { return <h3 className='text-sm font-semibold tracking-wide text-gray-600 dark:text-gray-300 uppercase'>{children}</h3>; }
export function CardContent({ children }) { return <div className='p-5'>{children}</div>; }
