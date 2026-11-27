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
import AccountSettings from './components/AccountSettings';
import NotificationCenter from './components/NotificationCenter';
import AdminDashboard from './pages/AdminDashboard';

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
      setPendingCount(await db.pendingLots.count());
    });
    db.pendingLots.count().then(setPendingCount);
    return () => {
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
      stopSync();
    };
  }, []);

  const refreshPending = async () => setPendingCount(await db.pendingLots.count());

  const logout = () => {
    const refreshToken = localStorage.getItem('agripulse_refresh_token');
    if (refreshToken) axios.post(`${API}/api/v1/auth/logout`, { refreshToken }).catch(() => {});
    localStorage.removeItem('agripulse_token');
    localStorage.removeItem('agripulse_refresh_token');
    localStorage.removeItem('agripulse_user');
    setUser(null);
  };

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      response => response,
      async error => {
        const original = error.config;
        if (error.response?.status !== 401 || original?._authRetry) throw error;
        const refreshToken = localStorage.getItem('agripulse_refresh_token');
        if (!refreshToken) throw error;
        try {
          const response = await axios.post(`${API}/api/v1/auth/refresh`, { refreshToken });
          localStorage.setItem('agripulse_token', response.data.token);
          localStorage.setItem('agripulse_refresh_token', response.data.refreshToken);
          localStorage.setItem('agripulse_user', JSON.stringify(response.data.user));
          setUser(response.data.user);
          original._authRetry = true;
          original.headers = original.headers || {};
          original.headers.Authorization = `Bearer ${response.data.token}`;
          return axios(original);
        } catch {
          localStorage.removeItem('agripulse_token');
          localStorage.removeItem('agripulse_refresh_token');
          localStorage.removeItem('agripulse_user');
          setUser(null);
          throw error;
        }
      }
    );
    return () => axios.interceptors.response.eject(interceptor);
  }, []);

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
          <div className="flex items-center gap-2">
            <NotificationCenter />
            <AccountSettings user={user} onUpdated={setUser} />
            <button onClick={logout} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Logout</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {user.role === 'FARMER' && <FarmerDashboard user={user} onPendingChange={refreshPending} />}
        {user.role === 'FPO_ADMIN' && <FpoPoolDashboard />}
        {user.role === 'BUYER' && <BuyerAuctionPortal />}
        {user.role === 'LOGISTICS' && <LogisticsTracker />}
        {user.role === 'ADMIN' && <AdminDashboard />}
      </main>
    </div>
  );
}
