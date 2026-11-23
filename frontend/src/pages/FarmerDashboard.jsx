import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/offlineDb';
import { syncPendingLots } from '../services/syncManager';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const crops = ['WHEAT','PADDY_COMMON','SOYBEAN','MUSTARD','CHICKPEA'];
const districts = ['GWALIOR','INDORE','BHOPAL','JABALPUR'];
const msp = { WHEAT:2425,PADDY_COMMON:2369,SOYBEAN:4892,MUSTARD:5950,CHICKPEA:5650 };
const modalFallback = { WHEAT:2520,PADDY_COMMON:2440,SOYBEAN:5100,MUSTARD:6120,CHICKPEA:5800 };

export default function FarmerDashboard({ user, onPendingChange }) {
  const [crop, setCrop] = useState('WHEAT');
  const [district, setDistrict] = useState(user.districtId || 'GWALIOR');
  const [grade, setGrade] = useState('A');
  const [moisture, setMoisture] = useState(11);
  const [quantity, setQuantity] = useState(10);
  const [lots, setLots] = useState([]);
  const [queue, setQueue] = useState([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!navigator.onLine) return;
    (async () => {
      for (const d of districts) for (const c of crops) {
        try {
          const res = await axios.get(`${API}/api/v1/advisory/fair-price`, { params:{ cropCode:c,districtId:d,grade:'A',moisturePct:11 } });
          await db.mandiCache.put({ districtId:d,cropCode:c,modalPriceInr:res.data.mandiModalInr,mspInr:res.data.mspInr,cachedAt:Date.now() });
        } catch {}
      }
    })();
  }, []);

  const refresh = async () => {
    setQueue(await db.pendingLots.toArray());
    try {
      const token = localStorage.getItem('agripulse_token');
      const res = await axios.get(`${API}/api/v1/lots`, { headers:{ Authorization:`Bearer ${token}` }, params:{ districtId:district } });
      setLots(res.data.lots);
    } catch {}
  };

  const floor = useMemo(async () => null, []);
  const [calculated, setCalculated] = useState(null);
  useEffect(() => {
    (async () => {
      let modal = modalFallback[crop];
      const cached = await db.mandiCache.get({ districtId:district,cropCode:crop });
      if (cached) modal = cached.modalPriceInr;
      const base = Math.max(modal, msp[crop]) * ({A:1.06,B:1,C:.92}[grade]);
      const penalty = Number((base * (Math.max(0,Number(moisture)-12)*.015)).toFixed(2));
      const floorPrice = Math.max(Number((base-penalty).toFixed(2)), Number((msp[crop]*.95).toFixed(2)));
      setCalculated({ modal, penalty, floorPrice, msp:msp[crop] });
    })();
  }, [crop,district,grade,moisture]);

  const registerLot = async event => {
    event.preventDefault();
    const record = {
      clientEventId:uuidv4(), cropCode:crop, quantityQuintals:Number(quantity),
      moisturePct:Number(moisture), grade, districtId:district,
      capturedAt:new Date().toISOString(), syncStatus:'PENDING', lastError:'',
      qualityCard:{ foreignMatterPct:1.2, brokenGrainPct:.8, assayedBy:'Farmer mobile assay' }
    };
    await db.pendingLots.add(record);
    setMessage(navigator.onLine ? 'Lot queued; syncing now.' : 'Lot saved locally. It will sync automatically.');
    await refresh();
    await onPendingChange?.();
    if (navigator.onLine) await syncPendingLots();
    await refresh();
    await onPendingChange?.();
  };

  const exportCsv = async () => {
    const token = localStorage.getItem('agripulse_token');
    const res = await axios.get(`${API}/api/v1/lots/export/csv`, { headers:{ Authorization:`Bearer ${token}` }, responseType:'blob' });
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url; link.download = 'agripulse-lots.csv'; link.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Fair-Price Calculator</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-sm font-semibold">Crop<select value={crop} onChange={e=>setCrop(e.target.value)} className="mt-1 w-full rounded border p-2">{crops.map(c=><option key={c}>{c}</option>)}</select></label>
          <label className="text-sm font-semibold">District<select value={district} onChange={e=>setDistrict(e.target.value)} className="mt-1 w-full rounded border p-2">{districts.map(d=><option key={d}>{d}</option>)}</select></label>
          <label className="text-sm font-semibold">Grade<select value={grade} onChange={e=>setGrade(e.target.value)} className="mt-1 w-full rounded border p-2"><option>A</option><option>B</option><option>C</option></select></label>
          <label className="text-sm font-semibold">Moisture %<input type="number" min="0" max="45" value={moisture} onChange={e=>setMoisture(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
        </div>
        {calculated && <div className="mt-5 rounded-xl bg-emerald-50 p-4"><p className="text-sm text-slate-600">Recommended floor</p><p className="text-3xl font-black text-emerald-800">₹{calculated.floorPrice.toFixed(2)}</p><p className="mt-2 text-xs text-slate-600">MSP ₹{calculated.msp} · Moisture penalty ₹{calculated.penalty}</p></div>}
      </section>
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Register Harvest Lot</h2>
        <form onSubmit={registerLot} className="mt-4 space-y-3">
          <input type="number" min="1" max="2000" required value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="Quantity in quintals" className="w-full rounded border p-3"/>
          <button className="w-full rounded-lg bg-emerald-700 py-3 font-bold text-white">Save & Sync Lot</button>
        </form>
        {message && <p className="mt-3 text-sm font-semibold text-emerald-700">{message}</p>}
      </section>
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Sync Queue</h2>
        <div className="mt-3 space-y-2">{queue.map(r=><div key={r.localId} className="rounded-lg border p-3 text-sm"><b>{r.cropCode}</b> · {r.quantityQuintals}q <span className={`float-right rounded px-2 py-1 text-xs ${r.syncStatus==='ERROR'?'bg-red-100 text-red-700':'bg-amber-100 text-amber-800'}`}>{r.syncStatus}</span>{r.lastError&&<p className="mt-1 text-xs text-red-600">{r.lastError}</p>}</div>)}</div>
      </section>
      <section className="lg:col-span-3 rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">My Lots & Sync Queue</h2><button onClick={exportCsv} className="rounded-lg border px-3 py-2 text-sm font-bold">CSV Export</button></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2">Lot</th><th>Crop</th><th>Quantity</th><th>Status</th></tr></thead><tbody>{lots.map(l=><tr key={l.id} className="border-b"><td className="py-3">{l.lot_code}</td><td>{l.crop_code}</td><td>{l.quantity_quintals} q</td><td><span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold">{l.status}</span></td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
