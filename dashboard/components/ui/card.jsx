export function Card({ className = "", children }) {
  return (
    <div className={
      "rounded-2xl border border-gray-200 bg-white shadow-sm " +
      "dark:bg-gray-800 dark:border-gray-700 " + className
    }>
      {children}
    </div>
  );
}

export function CardHeader({ children }) {
  return <div className="px-5 pt-5">{children}</div>;
}

export function CardTitle({ children }) {
  return <h3 className="text-sm font-semibold tracking-wide text-gray-600 dark:text-gray-300 uppercase">{children}</h3>;
}

export function CardContent({ className = "", children }) {
  return <div className={"px-5 pb-5 " + className}>{children}</div>;
}
