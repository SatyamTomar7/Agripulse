import { useEffect, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export default function BuyerAuctionPortal() {
  const [auctions,setAuctions]=useState([]);
  const [message,setMessage]=useState('');
  const [bidHistory,setBidHistory]=useState({});
  const [payments,setPayments]=useState([]);
  const token=localStorage.getItem('agripulse_token');
  const headers={ Authorization:`Bearer ${token}` };
  const load=async()=>{
    try { const r=await axios.get(`${API}/api/v1/auctions`); setAuctions(r.data.auctions); } catch(e){setMessage(e.response?.data?.message||'Unable to load auctions');}
  };
  useEffect(()=>{
    load();
    loadPayments();
    const socket=io(API);
    socket.on('bid:updated',()=>load());
    socket.on('auction:closed',()=>load());
    socket.on('lot:created',()=>load());
    return ()=>socket.disconnect();
  },[]);
  const bid=async(a,increment)=>{
    try {
      await axios.post(`${API}/api/v1/auctions/${a.id}/bids`,{bidAmountInr:Number(a.current_highest_bid_inr)+increment},{headers});
      setMessage(`Bid placed on ${a.lot_code}`);
      await load();
    } catch(e){setMessage(e.response?.data?.message||'Bid rejected');}
  };
  const loadHistory=async auction=>{
    try {
      const r=await axios.get(`${API}/api/v1/auctions/${auction.id}/bids`,{headers});
      setBidHistory(history=>({...history,[auction.id]:r.data.bids}));
    } catch(e){setMessage(e.response?.data?.message||'Unable to load bid history');}
  };
  const loadPayments=async()=>{
    try {
      const r=await axios.get(`${API}/api/v1/payments`,{headers});
      setPayments(r.data.payments);
    } catch(e){setMessage(e.response?.data?.message||'Unable to load payment status');}
  };
  return (
    <section><div className="mb-5"><p className="text-sm font-bold text-emerald-700">Live Procurement</p><h1 className="text-3xl font-black">Buyer Auction Portal</h1>{message&&<p className="mt-2 text-sm font-semibold text-emerald-700">{message}</p>}</div>
      {payments.length>0&&<div className="mb-5 space-y-2 rounded-xl border bg-white p-4">
        <h2 className="font-black">Escrow Payments</h2>
        <p className="rounded bg-amber-50 p-3 text-xs text-amber-900">Payment processing is not connected to a gateway. No payment or escrow transfer can be completed in this build.</p>
        {payments.map(payment=><div key={payment.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm"><div><b>{payment.invoice_no}</b> · ₹{payment.amount_inr} · <span className="font-bold">{payment.status}</span><p className="text-xs text-slate-500">Escrow payable: ₹{payment.payable_to_farmer_inr} · Commission: ₹{payment.commission_inr}</p></div></div>)}
      </div>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{auctions.map(a=>{
        const seconds=Math.max(0,Math.floor((new Date(a.ends_at)-Date.now())/1000));
        const minimumIncrement=Number(a.min_increment_inr);
        const increments=[minimumIncrement,minimumIncrement*2,minimumIncrement*4];
        return <article key={a.id} className="rounded-xl border bg-white p-5 shadow-sm"><div className="flex justify-between"><b>{a.lot_code}</b><span className="text-xs font-bold text-red-600">{Math.floor(seconds/3600)}h {Math.floor((seconds%3600)/60)}m</span></div><p className="mt-3 text-sm text-slate-600">{a.crop_code} · Grade {a.grade} · {a.quantity_quintals} q · {a.moisture_pct}% moisture</p><p className="mt-3 text-sm">Statutory floor <b>₹{a.floor_price_inr}</b></p><p className="mt-1 text-2xl font-black text-emerald-800">₹{a.current_highest_bid_inr}</p><div className="mt-4 grid grid-cols-3 gap-2">{increments.map(n=><button key={n} onClick={()=>bid(a,n)} className="rounded-lg bg-emerald-700 py-2 text-sm font-bold text-white">+₹{n}</button>)}</div><button onClick={()=>loadHistory(a)} className="mt-3 text-xs font-bold text-emerald-800">View bid history</button>{bidHistory[a.id] && <div className="mt-2 space-y-1 text-xs">{bidHistory[a.id].map(b=><p key={b.id}><b>₹{b.bid_amount_inr}</b> · {b.bidder_label}</p>)}</div>}</article>;
      })}</div>
    </section>
  );
}
