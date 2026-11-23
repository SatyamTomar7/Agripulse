import { Cloud, CloudOff, Languages, RefreshCw } from 'lucide-react';
import { syncPendingLots } from '../services/syncManager';

export default function OfflineBanner({ online, pendingCount, language, setLanguage, onSync }) {
  const sync = async () => { await syncPendingLots(); onSync?.(); };
  return (
    <nav className="sticky top-0 z-40 border-b border-emerald-900/10 bg-white/95 px-4 py-2 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-lg font-black text-emerald-800">
          {online ? <Cloud size={21} /> : <CloudOff size={21} />}
          AgriPulse
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>
            {online ? 'ONLINE' : 'OFFLINE MODE — Saving Locally'}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{pendingCount} pending</span>
          <button onClick={sync} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-bold"><RefreshCw size={14}/> Sync Now</button>
          <button onClick={() => setLanguage(language === 'EN' ? 'हिं' : 'EN')} className="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-bold">
            <Languages size={14}/> {language}
          </button>
        </div>
      </div>
    </nav>
  );
}
