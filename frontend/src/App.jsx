import { useEffect, useState } from 'react';
import axios from 'axios';
import OfflineBanner from './components/OfflineBanner';
import Login from './pages/Login';
import FarmerDashboard from './pages/FarmerDashboard';
import FpoPoolDashboard from './pages/FpoPoolDashboard';
import BuyerAuctionPortal from './pages/BuyerAuctionPortal';
import LogisticsTracker from './pages/LogisticsTracker';
import { startSyncManager } from './services/syncManager';
import { db } from './db/offlineDb';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function App() {
  const [user, setUser] = useState(() => JSON.parse(localStorage.getItem('agripulse_user') || 'null'));
  const [language, setLanguage] = useState('EN');
  const [online, setOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    const stopSync = startSyncManager(async () => {
      setPendingCount(await db.pendingLots.where('syncStatus').equals('PENDING').count());
    });
    db.pendingLots.where('syncStatus').equals('PENDING').count().then(setPendingCount);
    return () => {
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
      stopSync();
    };
  }, []);

  const refreshPending = async () => setPendingCount(await db.pendingLots.where('syncStatus').equals('PENDING').count());
  const logout = () => {
    localStorage.removeItem('agripulse_token');
    localStorage.removeItem('agripulse_user');
    setUser(null);
  };

  if (!user) return (
    <div className="min-h-screen bg-emerald-50">
      <OfflineBanner online={online} pendingCount={pendingCount} language={language} setLanguage={setLanguage} onSync={refreshPending} />
      <Login onLogin={nextUser => { setUser(nextUser); refreshPending(); }} />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <OfflineBanner online={online} pendingCount={pendingCount} language={language} setLanguage={setLanguage} onSync={refreshPending} />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-emerald-700">AgriPulse</p>
            <p className="text-sm text-slate-600">{user.fullName} · {user.role}</p>
          </div>
          <button onClick={logout} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Logout</button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {user.role === 'FARMER' && <FarmerDashboard user={user} onPendingChange={refreshPending} />}
        {user.role === 'FPO_ADMIN' && <FpoPoolDashboard />}
        {user.role === 'BUYER' && <BuyerAuctionPortal />}
        {user.role === 'LOGISTICS' && <LogisticsTracker />}
      </main>
    </div>
  );
}
