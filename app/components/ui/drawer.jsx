"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

/**
 * Drawer component – modern frosted glass style
 */
export function Drawer({ open, onOpenChange, title, children }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            {/* Background overlay */}
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </Dialog.Overlay>

            {/* Drawer panel */}
            <Dialog.Content asChild>
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 260, damping: 26 }}
                className="fixed bottom-0 left-0 right-0 z-50
                           backdrop-blur-md bg-white/70 dark:bg-gray-900/70
                           border-t border-white/20 dark:border-gray-700/50
                           rounded-t-3xl shadow-2xl p-6
                           max-h-[85vh] overflow-y-auto
                           text-gray-900 dark:text-gray-100"
              >
                <div className="flex justify-between items-center mb-4">
                  <Dialog.Title className="text-lg font-semibold tracking-tight">
                    {title}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      onClick={() => onOpenChange(false)}
                      className="p-2 rounded-full hover:bg-white/40 dark:hover:bg-gray-800/60 transition"
                    >
                      <X className="h-5 w-5 text-gray-600 dark:text-gray-300" />
                    </button>
                  </Dialog.Close>
                </div>

                <div className="space-y-4">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
