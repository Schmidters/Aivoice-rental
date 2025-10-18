export function Label({ children, className = '', ...props }) {
  return (
    <label className={`text-sm font-medium text-gray-700 dark:text-gray-300 ${className}`} {...props}>
      {children}
    </label>
  );
}
