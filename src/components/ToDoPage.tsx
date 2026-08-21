import React, { useState, useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { auth } from '../lib/firebase';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  Plus, Trash2, CheckCircle2, Circle, Clock,
  AlertCircle, ChevronRight, MessageSquare,
  Lightbulb, Star, Filter, MoreVertical, Edit2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { format } from 'date-fns';

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn("glass/50 border border-slate-800/50 rounded-2xl overflow-hidden", className)}>
    {children}
  </div>
);

export const ToDoPage: React.FC = () => {
  const [newIdea, setNewIdea] = useState({ title: '', description: '', priority: 'MEDIUM' as const, status: 'PENDING' as const });
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'>('ALL');

  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  const utils = trpc.useUtils();
  const { data: todos, isLoading } = trpc.getTodos.useQuery(undefined, { enabled: !!user });
  const addMutation = trpc.addTodo.useMutation({
    onSuccess: () => {
      utils.getTodos.invalidate();
      setNewIdea({ title: '', description: '', priority: 'MEDIUM', status: 'PENDING' });
      setIsAdding(false);
    },
    onError: (err) => {
      alert(`Failed to save idea: ${err.message}`);
    }
  });

  const updateMutation = trpc.updateTodo.useMutation({
    onSuccess: () => utils.getTodos.invalidate()
  });

  const deleteMutation = trpc.deleteTodo.useMutation({
    onSuccess: () => utils.getTodos.invalidate()
  });

  const filteredTodos = todos?.filter(t => filter === 'ALL' || t.status === filter) || [];

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIdea.title) return;
    console.log('[TODO] Sending new idea:', newIdea);
    addMutation.mutate(newIdea);
  };

  const toggleStatus = (todo: any) => {
    const nextStatus = {
      'PENDING': 'IN_PROGRESS',
      'IN_PROGRESS': 'COMPLETED',
      'COMPLETED': 'PENDING'
    }[todo.status as 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'] as any;
    
    updateMutation.mutate({ id: todo.id, status: nextStatus });
  };

  if (!user) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="glass/50 border border-slate-800/50 rounded-2xl p-8 text-center text-sm text-slate-400 font-data">
          Sign in to view and manage your ideas.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-4xl font-black text-white italic tracking-tighter uppercase flex items-center gap-3">
            <Lightbulb className="w-8 h-8 text-amber-500 fill-amber-500/20" />
            Implementation Ideas
          </h1>
          <p className="text-slate-400 text-xs font-bold font-display uppercase tracking-widest mt-1">Capture and track future platform enhancements</p>
        </div>
        <button 
          onClick={() => setIsAdding(!isAdding)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl text-sm font-black font-display uppercase tracking-widest transition-all flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          {isAdding ? 'Close Form' : 'New Idea'}
        </button>
      </div>

      {/* Add Form */}
      <AnimatePresence>
        {isAdding && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <Card className="p-6 glass border-indigo-500/30">
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
                  <div className="md:col-span-3">
                    <label className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1.5 block">Title</label>
                    <input 
                      type="text"
                      value={newIdea.title}
                      onChange={e => setNewIdea({...newIdea, title: e.target.value})}
                      placeholder="e.g. Implement WebSocket streaming"
                      className="w-full glass-strong border border-slate-800/50 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    />
                  </div>
                  <div className="md:col-span-1.5">
                    <label className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1.5 block">Priority</label>
                    <select 
                      value={newIdea.priority}
                      onChange={e => setNewIdea({...newIdea, priority: e.target.value as any})}
                      className="w-full glass-strong border border-slate-800/50 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </select>
                  </div>
                  <div className="md:col-span-1.5">
                    <label className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1.5 block">Initial Status</label>
                    <select 
                      value={newIdea.status}
                      onChange={e => setNewIdea({...newIdea, status: e.target.value as any})}
                      className="w-full glass-strong border border-slate-800/50 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    >
                      <option value="PENDING">Pending</option>
                      <option value="IN_PROGRESS">In Progress</option>
                      <option value="COMPLETED">Completed</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1.5 block">Description</label>
                  <textarea 
                    value={newIdea.description}
                    onChange={e => setNewIdea({...newIdea, description: e.target.value})}
                    placeholder="Briefly describe the implementation details..."
                    rows={3}
                    className="w-full glass-strong border border-slate-800/50 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all resize-none"
                  />
                </div>
                <div className="flex justify-end gap-3">
                  <button 
                    type="button"
                    onClick={() => setIsAdding(false)}
                    className="text-slate-400 hover:text-white px-4 py-2 text-xs font-bold font-display uppercase tracking-widest transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={!newIdea.title || addMutation.isPending}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-6 py-2 rounded-xl text-xs font-black font-display uppercase tracking-widest transition-all"
                  >
                    {addMutation.isPending ? 'Saving...' : 'Save Idea'}
                  </button>
                </div>
              </form>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
        {(['ALL', 'PENDING', 'IN_PROGRESS', 'COMPLETED'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-4 py-2 rounded-full text-[10px] font-black font-display uppercase tracking-widest transition-all border whitespace-nowrap",
              filter === f 
                ? "bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/20" 
                : "glass border-slate-800/50 text-slate-400 hover:text-slate-300 hover:border-slate-800/30"
            )}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-4">
        {isLoading ? (
          [1, 2, 3].map(i => <div key={i} className="h-24 glass/50 animate-pulse rounded-2xl border border-slate-800/50" />)
        ) : filteredTodos.length > 0 ? (
          filteredTodos.map((todo) => (
            <motion.div
              layout
              key={todo.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="group"
            >
              <Card className={cn(
                "p-4 transition-all hover:bg-slate-900/80 border-l-4",
                todo.status === 'COMPLETED' ? "border-l-emerald-500" : 
                todo.status === 'IN_PROGRESS' ? "border-l-indigo-500" : "border-l-slate-700",
                todo.status === 'COMPLETED' && "opacity-60"
              )}>
                <div className="flex items-start gap-4">
                  <button 
                    onClick={() => toggleStatus(todo)}
                    title="Click to cycle status (Pending → In Progress → Completed)"
                    className={cn(
                      "mt-1 p-0.5 rounded-full transition-colors",
                      todo.status === 'COMPLETED' ? "text-emerald-500" : 
                      todo.status === 'IN_PROGRESS' ? "text-indigo-500" : "text-slate-300 hover:text-slate-400"
                    )}
                  >
                    {todo.status === 'COMPLETED' ? <CheckCircle2 className="w-5 h-5" /> : 
                     todo.status === 'IN_PROGRESS' ? <Clock className="w-5 h-5 animate-pulse" /> : 
                     <Circle className="w-5 h-5" />}
                  </button>
                  
                  <div className="flex-1">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className={cn(
                          "text-sm font-black text-white uppercase tracking-tight italic",
                          todo.status === 'COMPLETED' && "line-through text-slate-400"
                        )}>
                          {todo.title}
                        </h3>
                        {todo.description && (
                          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{todo.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={cn(
                          "text-[10px] font-black px-2 py-0.5 rounded tracking-tighter uppercase",
                          todo.priority === 'HIGH' ? "bg-rose-500/10 text-rose-500" :
                          todo.priority === 'MEDIUM' ? "bg-amber-500/10 text-amber-500" : "bg-slate-800 text-slate-400"
                        )}>
                          {todo.priority}
                        </span>
                        <button 
                          onClick={() => deleteMutation.mutate({ id: todo.id })}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-rose-500 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-4 mt-3">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Clock className="w-3 h-3" />
                        <span className="text-[10px] font-bold font-display uppercase tracking-widest">{format(new Date(todo.createdAt), 'MMM dd, HH:mm')}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Filter className="w-3 h-3" />
                        <span className="text-[10px] font-black font-display uppercase tracking-widest italic">{todo.category}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>
          ))
        ) : (
          <div className="py-24 flex flex-col items-center justify-center bg-slate-950/20 rounded-3xl border border-slate-800/50 border-dashed">
            <Star className="w-12 h-12 text-slate-200 mb-4 animate-pulse" />
            <h3 className="text-slate-400 font-black text-lg uppercase tracking-tighter italic">No ideas found</h3>
            <p className="text-slate-400 text-[10px] font-bold font-display uppercase tracking-widest mt-1">Start building the roadmap to intelligence</p>
          </div>
        )}
      </div>
    </div>
  );
};
