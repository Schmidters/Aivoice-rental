export default function Button({ className = "", children, ...props }) {
  return (
    <button
      className={
        "rounded-xl px-4 py-2 text-sm font-medium shadow-sm border border-gray-200 bg-white hover:bg-gray-50 active:scale-[0.99] transition " +
        "dark:bg-gray-800 dark:border-gray-700 dark:hover:bg-gray-700 " +
        className
      }
      {...props}
    >
      {children}
    </button>
  );
}
