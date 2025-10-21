export function Button({ children, variant = 'default', className = '', ...props }) {
  const base =
    'inline-flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition';
  const variants = {
    default: 'bg-indigo-600 hover:bg-indigo-700 text-white',
    outline: 'border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300',
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}
