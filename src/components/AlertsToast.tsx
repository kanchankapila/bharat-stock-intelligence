import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useAlerts } from '../hooks/useAlerts';
import { X, Info, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '../lib/utils';

export function AlertsToast() {
  const { alerts, removeAlert } = useAlerts();

  return (
    <div className="fixed top-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
      <AnimatePresence>
        {alerts.map((alert) => (
          <motion.div
            key={alert.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.95 }}
            className={cn(
              'w-80 bg-slate-900 border-l-4 p-4 rounded-xl shadow-2xl pointer-events-auto flex gap-3',
              alert.type === 'SUCCESS' ? 'border-emerald-500' : 
              alert.type === 'WARNING' ? 'border-orange-500' :
              alert.type === 'ERROR' ? 'border-red-500' : 'border-blue-500'
            )}
          >
            <div className="flex-shrink-0 mt-1">
              {alert.type === 'SUCCESS' ? <CheckCircle className="w-5 h-5 text-emerald-500" /> :
               alert.type === 'WARNING' ? <AlertTriangle className="w-5 h-5 text-orange-500" /> :
               alert.type === 'ERROR' ? <XCircle className="w-5 h-5 text-red-500" /> :
               <Info className="w-5 h-5 text-blue-500" />}
            </div>
            <div className="flex-1">
              <h4 className="text-white font-semibold text-sm">{alert.title}</h4>
              <p className="text-slate-400 text-sm mt-1">{alert.message}</p>
            </div>
            <button
              onClick={() => removeAlert(alert.id)}
              className="text-slate-500 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
