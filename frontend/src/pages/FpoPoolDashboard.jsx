import { useEffect, useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export default function FpoPoolDashboard() {
  const [lots, setLots] = useState([]);
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const [auctions, setAuctions] = useState([]);
  const token = localStorage.getItem('agripulse_token');
  const headers = { Authorization:`Bearer ${token}` };
  const load = async () => {
    try {
      const [lotsResponse, auctionsResponse] = await Promise.all([
        axios.get(`${API}/api/v1/lots`, { headers, params:{ status:'LISTED' } }),
        axios.get(`${API}/api/v1/auctions/owned`, { headers })
      ]);
      setLots(lotsResponse.data.lots);
      setAuctions(auctionsResponse.data.auctions);
    } catch (err) { setMessage(err.response?.data?.message || 'Unable to load lots'); }
  };
  useEffect(()=>{load();},[]);
  const toggle = id => setSelected(s => s.includes(id) ? s.filter(x=>x!==id) : [...s,id]);
  const compatible = selected.length ? lots.find(l=>l.id===selected[0]) : null;
  const showPreview = async () => {
    try {
      const res = await axios.post(`${API}/api/v1/lots/pool/preview`, { lotIds:selected }, { headers });
      setPreview(res.data);
    } catch (err) { setMessage(err.response?.data?.message || 'Unable to preview pool'); }
  };
  const pool = async () => {
    try {
      const ids = selected;
      const res = await axios.post(`${API}/api/v1/lots/pool`, { lotIds:ids }, { headers });
      setMessage(`Pooled lot ${res.data.pooledLot.lot_code} into a bulk auction.`);
      setSelected([]); setPreview(null); await load();
    } catch (err) { setMessage(err.response?.data?.message || 'Pooling failed'); }
  };
  const verifyQuality = async (lot, status) => {
    try {
      await axios.patch(`${API}/api/v1/lots/${lot.id}/quality/${status}`, {}, { headers });
      setMessage(status === 'VERIFIED' ? `Quality verified for ${lot.lot_code}` : `Quality rejected for ${lot.lot_code}`);
      await load();
    } catch (err) { setMessage(err.response?.data?.message || 'Quality update failed'); }
  };
  const acceptBid = async auction => {
    try {
      await axios.post(`${API}/api/v1/auctions/${auction.id}/accept`, {}, { headers });
      setMessage(`Winning bid accepted for ${auction.lot_code}`);
      await load();
    } catch (err) { setMessage(err.response?.data?.message || 'Unable to accept bid'); }
  };
  return (
    <section>
      <div className="mb-5 flex items-end justify-between"><div><p className="text-sm font-bold text-emerald-700">FPO Aggregation</p><h1 className="text-3xl font-black">Bulk Truckload Pool</h1></div><button disabled={!selected.length} onClick={showPreview} className="rounded-lg bg-emerald-700 px-5 py-3 font-bold text-white disabled:opacity-40">Preview Pool</button></div>
      {message && <p className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">{message}</p>}
      {auctions.length > 0 && <div className="mb-5 grid gap-3 md:grid-cols-2">
        {auctions.map(auction => <article key={auction.id} className="rounded-xl border bg-white p-4">
          <b>{auction.lot_code}</b>
          <p className="mt-1 text-sm">Current bid ₹{auction.current_highest_bid_inr} · Ends {new Date(auction.ends_at).toLocaleString()}</p>
          {new Date(auction.ends_at) <= new Date() && <button onClick={()=>acceptBid(auction)} className="mt-3 rounded bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Accept Winning Bid</button>}
        </article>)}
      </div>}
      {preview && <div className="mb-5 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
        <h2 className="font-black">Pool Preview</h2>
        <p className="mt-2 text-sm">{preview.lotCount} lots · {preview.totalQuintals} quintals · {preview.cropCode} · Grade {preview.grade}</p>
        <p className="text-sm">Weighted moisture {preview.weightedMoisturePct}% · Weighted floor ₹{preview.weightedFloorInr}</p>
        <p className="mt-1 text-xs text-slate-600">Minimum {preview.minimumQuintals}q · Capacity {preview.capacityQuintals}q</p>
        <div className="mt-3 flex gap-2"><button disabled={!preview.canPool} onClick={pool} className="rounded bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">Confirm Pool</button><button onClick={()=>setPreview(null)} className="rounded border px-4 py-2 text-sm font-bold">Cancel</button></div>
      </div>}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{lots.map(l=>{
        const allowed = !compatible || (compatible.crop_code===l.crop_code && compatible.grade===l.grade);
        const qualityStatus = l.quality_card?.assessmentStatus || 'NOT_SUBMITTED';
        return <article key={l.id} className={`rounded-xl border bg-white p-4 shadow-sm ${selected.includes(l.id)?'ring-2 ring-emerald-600':''}`}>
          <label><input type="checkbox" checked={selected.includes(l.id)} disabled={!allowed || qualityStatus !== 'VERIFIED'} onChange={()=>toggle(l.id)} className="mr-3"/><b>{l.lot_code}</b></label>
          <p className="mt-2 text-sm text-slate-600">{l.crop_code} · Grade {l.grade} · {l.quantity_quintals} quintals</p>
          <p className="mt-1 text-xs text-slate-500">{l.district_id} · Floor ₹{l.recommended_floor_inr}</p>
          <p className="mt-2 text-xs font-bold">Quality: {qualityStatus}</p>
          {qualityStatus === 'SUBMITTED' && <div className="mt-3 flex gap-2">
            <button onClick={()=>verifyQuality(l,'VERIFIED')} className="rounded bg-emerald-700 px-3 py-1 text-xs font-bold text-white">Verify</button>
            <button onClick={()=>verifyQuality(l,'REJECTED')} className="rounded border border-red-400 px-3 py-1 text-xs font-bold text-red-700">Reject</button>
          </div>}
          {qualityStatus === 'NOT_SUBMITTED' && <p className="mt-2 text-xs text-slate-500">Awaiting farmer quality submission.</p>}
        </article>;
      })}</div>
    </section>
  );
}
