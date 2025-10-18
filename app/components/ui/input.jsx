import * as React from 'react';

export const Input = React.forwardRef(({ className = '', ...props }, ref) => (
  <input
    ref={ref}
    className={`border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 w-full bg-white dark:bg-gray-900 ${className}`}
    {...props}
  />
));
Input.displayName = 'Input';
