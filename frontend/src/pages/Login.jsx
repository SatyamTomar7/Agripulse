import { useEffect, useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('FARMER');
  const [districtId, setDistrictId] = useState('GWALIOR');
  const [stateName, setStateName] = useState('Madhya Pradesh');
  const [village, setVillage] = useState('');
  const [address, setAddress] = useState('');
  const [districts, setDistricts] = useState([{ code:'GWALIOR', name:'Gwalior', stateName:'Madhya Pradesh' }]);
  const [error, setError] = useState('');
  useEffect(() => {
    axios.get(`${API}/api/v1/master-data`).then(response => setDistricts(response.data.districts)).catch(() => {});
  }, []);
  const submit = async event => {
    event?.preventDefault?.();
    setError('');
    try {
      const endpoint = mode === 'login' ? 'login' : 'register';
      const payload = mode === 'login'
        ? { phone: phone.trim(), password }
        : { fullName: fullName.trim(), phone: phone.trim(), password, role, districtId: districtId.trim().toUpperCase(), stateName, village, address };
      const response = await axios.post(`${API}/api/v1/auth/${endpoint}`, payload);
      if (response.data.pendingApproval) {
        setError(response.data.message);
        setMode('login');
        return;
      }
      localStorage.setItem('agripulse_token', response.data.token);
      localStorage.setItem('agripulse_refresh_token', response.data.refreshToken);
      localStorage.setItem('agripulse_user', JSON.stringify(response.data.user));
      onLogin(response.data.user);
    } catch (err) { setError(err.response?.data?.message || `Unable to ${mode}`); }
  };
  const switchMode = nextMode => {
    setMode(nextMode);
    setError('');
  };
  return (
    <div className="mx-auto flex min-h-[85vh] max-w-5xl items-center px-4">
      <div className="grid w-full gap-8 rounded-2xl bg-white p-6 shadow-xl md:grid-cols-2 md:p-10">
        <div>
          <p className="text-sm font-bold uppercase tracking-widest text-emerald-700">Offline-first marketplace</p>
          <h1 className="mt-3 text-4xl font-black text-slate-900">Fair prices. Better harvests.</h1>
          <p className="mt-4 text-slate-600">Register lots without internet, compare mandi prices, pool FPO inventory and complete traceable auctions.</p>
        </div>
        <div>
          <div className="mb-4 flex rounded-lg bg-slate-100 p-1">
            <button type="button" onClick={() => switchMode('login')} className={`flex-1 rounded-md px-3 py-2 text-sm font-bold ${mode === 'login' ? 'bg-white text-emerald-700 shadow' : 'text-slate-600'}`}>Login</button>
            <button type="button" onClick={() => switchMode('register')} className={`flex-1 rounded-md px-3 py-2 text-sm font-bold ${mode === 'register' ? 'bg-white text-emerald-700 shadow' : 'text-slate-600'}`}>Register</button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'register' && <>
              <input aria-label="Full name" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Full name" className="w-full rounded-lg border px-4 py-3"/>
              <select aria-label="Role" value={role} onChange={e => setRole(e.target.value)} className="w-full rounded-lg border bg-white px-4 py-3">
                <option value="FARMER">Farmer</option>
                <option value="FPO_ADMIN">FPO Admin</option>
                <option value="BUYER">Buyer</option>
                <option value="LOGISTICS">Logistics</option>
              </select>
              <select aria-label="District" required value={districtId} onChange={e => {
                const selected = districts.find(d => d.code === e.target.value);
                setDistrictId(e.target.value);
                setStateName(selected?.stateName || 'Madhya Pradesh');
              }} className="w-full rounded-lg border bg-white px-4 py-3">
                {districts.map(d => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
              <input aria-label="Village" value={village} onChange={e => setVillage(e.target.value)} placeholder="Village" className="w-full rounded-lg border px-4 py-3"/>
              <input aria-label="Address" value={address} onChange={e => setAddress(e.target.value)} placeholder="Address" className="w-full rounded-lg border px-4 py-3"/>
            </>}
            <input aria-label="Phone" name="username" autoComplete="username" required value={phone} onChange={e => setPhone(e.target.value)} placeholder="Mobile number" className="w-full rounded-lg border px-4 py-3"/>
            <input aria-label="Password" name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min. 8 characters)" className="w-full rounded-lg border px-4 py-3"/>
            {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
            <button type="submit" className="w-full rounded-lg bg-emerald-700 px-4 py-3 font-bold text-white">{mode === 'login' ? 'Login' : 'Create account'}</button>
            {mode === 'register' && role !== 'FARMER' && <p className="text-xs text-slate-500">This role requires administrator approval before sign-in.</p>}
          </form>
        </div>
      </div>
    </div>
  );
}
