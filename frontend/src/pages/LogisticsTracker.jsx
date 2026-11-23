import { useEffect, useState } from 'react';
import axios from 'axios';
import { Truck } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export default function LogisticsTracker(){
  const [dispatches,setDispatches]=useState([]);
  const [message,setMessage]=useState('');
  const token=localStorage.getItem('agripulse_token');
  const headers={Authorization:`Bearer ${token}`};
  const load=async()=>{try{const r=await axios.get(`${API}/api/v1/dispatches`,{headers});setDispatches(r.data.dispatches);}catch(e){setMessage(e.response?.data?.message||'Unable to load dispatches');}};
  useEffect(()=>{load();},[]);
  const advance=async d=>{
    const next=d.logistics_status==='PENDING_PICKUP'?'IN_TRANSIT':'DELIVERED';
    const lat=d.current_lat+(next==='DELIVERED'?0.02:0.01);
    const lng=d.current_lng+(next==='DELIVERED'?0.03:0.01);
    try{await axios.patch(`${API}/api/v1/dispatches/${d.id}/status`,{logisticsStatus:next,vehicleNumber:d.vehicle_number||'MP09-AG-2034',currentLat:lat,currentLng:lng},{headers});setMessage(next==='DELIVERED'?'Delivered · escrow released':'Truck marked in transit');await load();}catch(e){setMessage(e.response?.data?.message||'Status update failed');}
  };
  return <section><div className="mb-5"><p className="text-sm font-bold text-emerald-700">Logistics & Escrow</p><h1 className="text-3xl font-black">Dispatch Tracking</h1>{message&&<p className="mt-2 text-sm font-semibold text-emerald-700">{message}</p>}</div>
    <div className="space-y-4">{dispatches.map(d=>{
      const step=d.logistics_status==='DELIVERED'?3:d.logistics_status==='IN_TRANSIT'?2:1;
      return <article key={d.id} className="rounded-xl border bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><Truck className="text-emerald-700"/><div><b>Dispatch #{d.id}</b><p className="text-sm text-slate-600">₹{d.total_amount_inr} · Escrow {d.escrow_status}</p></div></div>{step<3&&<button onClick={()=>advance(d)} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white">{step===1?'Start Transit':'Mark Delivered'}</button>}</div>
        <div className="mt-5 grid grid-cols-3 gap-2">{['Pickup Scheduled','In Transit','Delivered & Escrow Released'].map((label,i)=><div key={label}><div className={`h-2 rounded ${i+1<=step?'bg-emerald-600':'bg-slate-200'}`}/><p className="mt-2 text-xs font-bold text-slate-600">{label}</p></div>)}</div><p className="mt-4 text-xs text-slate-500">GPS {d.current_lat}, {d.current_lng}</p></article>;
    })}</div>
  </section>
}
