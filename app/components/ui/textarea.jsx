import * as React from 'react';

export const Textarea = React.forwardRef(({ className = '', ...props }, ref) => (
  <textarea
    ref={ref}
    className={`border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 w-full bg-white dark:bg-gray-900 ${className}`}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
