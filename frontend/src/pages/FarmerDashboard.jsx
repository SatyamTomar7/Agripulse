import { useEffect, useState } from 'react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/offlineDb';
import { retryAllPendingLots, syncPendingLots } from '../services/syncManager';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
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
  const [foreignMatter, setForeignMatter] = useState(1.2);
  const [brokenGrain, setBrokenGrain] = useState(0.8);
  const [capturedPhoto, setCapturedPhoto] = useState('');
  const [latitude, setLatitude] = useState(null);
  const [longitude, setLongitude] = useState(null);
  const [nearbyPrices, setNearbyPrices] = useState([]);
  const [crops, setCrops] = useState([
    { code:'WHEAT', name:'Wheat' },{ code:'PADDY_COMMON', name:'Paddy (Common)' },
    { code:'SOYBEAN', name:'Soybean' },{ code:'MUSTARD', name:'Mustard' },{ code:'CHICKPEA', name:'Chickpea' }
  ]);
  const [districts, setDistricts] = useState([
    { code:'GWALIOR', name:'Gwalior' },{ code:'INDORE', name:'Indore' },
    { code:'BHOPAL', name:'Bhopal' },{ code:'JABALPUR', name:'Jabalpur' }
  ]);

  useEffect(() => {
    refresh();
    axios.get(`${API}/api/v1/master-data`).then(response => {
      setCrops(response.data.crops);
      setDistricts(response.data.districts);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!navigator.onLine) return;
    (async () => {
      for (const d of districts) for (const c of crops) {
        try {
          const res = await axios.get(`${API}/api/v1/advisory/fair-price`, { params:{ cropCode:c.code,districtId:d.code,grade:'A',moisturePct:11 } });
          await db.mandiCache.put({ districtId:d.code,cropCode:c.code,modalPriceInr:res.data.mandiModalInr,mspInr:res.data.mspInr,cachedAt:Date.now() });
        } catch {}
      }
    })();
  }, []);

  const refresh = async () => {
    setQueue(await db.pendingLots.toArray());
    try {
      const token = localStorage.getItem('agripulse_token');
      const res = await axios.get(`${API}/api/v1/lots`, { headers:{ Authorization:`Bearer ${token}` }, params:{ mine:'true' } });
      setLots(res.data.lots);
    } catch {}
  };

  const [calculated, setCalculated] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const [fairPrice, nearby] = await Promise.all([
          axios.get(`${API}/api/v1/advisory/fair-price`, { params:{ cropCode:crop,districtId:district,grade,moisturePct:moisture } }),
          axios.get(`${API}/api/v1/advisory/nearby-prices`, { params:{ cropCode:crop,districtId:district } })
        ]);
        setCalculated({
          modal:fairPrice.data.mandiModalInr,
          penalty:fairPrice.data.moisturePenaltyInr,
          floorPrice:fairPrice.data.recommendedFloorInr,
          msp:fairPrice.data.mspInr,
          updatedAt:fairPrice.data.priceUpdatedAt,
          source:fairPrice.data.source
        });
        setNearbyPrices(nearby.data.prices);
      } catch {
        let modal = modalFallback[crop];
        const cached = await db.mandiCache.get({ districtId:district,cropCode:crop });
        if (cached) modal = cached.modalPriceInr;
        const base = Math.max(modal, msp[crop]) * ({A:1.06,B:1,C:.92}[grade]);
        const penalty = Number((base * (Math.max(0,Number(moisture)-12)*.015)).toFixed(2));
        const floorPrice = Math.max(Number((base-penalty).toFixed(2)), Number((msp[crop]*.95).toFixed(2)));
        setCalculated({ modal, penalty, floorPrice, msp:msp[crop], source:'Offline cached estimate' });
      }
    })();
  }, [crop,district,grade,moisture]);

  const registerLot = async event => {
    event.preventDefault();
    if (foreignMatter < 0 || foreignMatter > 100 || brokenGrain < 0 || brokenGrain > 100) {
      setMessage('Quality percentages must be between 0 and 100.');
      return;
    }
    let captureLatitude = latitude;
    let captureLongitude = longitude;
    if (navigator.geolocation) {
      try {
        const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout:5000, maximumAge:60000 }));
        captureLatitude = position.coords.latitude;
        captureLongitude = position.coords.longitude;
        setLatitude(captureLatitude);
        setLongitude(captureLongitude);
      } catch {}
    }
    const record = {
      clientEventId:uuidv4(), cropCode:crop, quantityQuintals:Number(quantity),
      moisturePct:Number(moisture), grade, districtId:district,
      capturedAt:new Date().toISOString(), syncStatus:'PENDING', lastError:'',
      attemptCount:0,
      captureLatitude,
      captureLongitude,
      qualityCard:{
        foreignMatterPct:Number(foreignMatter),
        brokenGrainPct:Number(brokenGrain),
        photoDataUrl:capturedPhoto || null,
        assayedBy:'Farmer mobile assay'
      }
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

  const capturePhoto = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessage('Only image photos can be attached.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage('Photo must be smaller than 2 MB.');
      return;
    }
    let uploadFile = file;
    let bitmap;
    try {
      if (file.size > 200 * 1024) {
        if (typeof createImageBitmap !== 'function') throw new Error('Photo compression is not supported by this browser.');
        bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        let scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
        let quality = 0.72;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          uploadFile = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (!uploadFile) throw new Error('Unable to compress photo.');
          if (uploadFile.size <= 200 * 1024) break;
          scale *= 0.85;
          quality *= 0.8;
        }
        if (uploadFile.size > 200 * 1024) throw new Error('Photo could not be compressed below the 200 KB sync limit.');
      }
    } catch (error) {
      setMessage(error.message || 'Unable to process photo.');
      return;
    } finally {
      bitmap?.close();
    }
    let dataUrl;
    try {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(uploadFile);
      });
    } catch {
      setMessage('Unable to read the selected photo.');
      return;
    }
    if (dataUrl.length > 280000) {
      setMessage('Photo is too large to sync. Please choose a smaller image.');
      return;
    }
    setCapturedPhoto(dataUrl);
    setMessage('Photo attached and compressed for offline sync.');
  };

  const retryQueue = async () => {
    setMessage('Retrying queued lots...');
    await retryAllPendingLots();
    await refresh();
    await onPendingChange?.();
  };

  const cancelLot = async lot => {
    if (!window.confirm(`Cancel lot ${lot.lot_code}?`)) return;
    try {
      const token = localStorage.getItem('agripulse_token');
      await axios.post(`${API}/api/v1/lots/${lot.id}/cancel`, { reason:'Canceled from farmer dashboard' }, { headers:{ Authorization:`Bearer ${token}` } });
      setMessage(`Lot ${lot.lot_code} canceled`);
      await refresh();
    } catch (error) { setMessage(error.response?.data?.message || 'Unable to cancel lot'); }
  };

  const relistLot = async lot => {
    try {
      const token = localStorage.getItem('agripulse_token');
      await axios.post(`${API}/api/v1/lots/${lot.id}/relist`, {}, { headers:{ Authorization:`Bearer ${token}` } });
      setMessage(`Lot ${lot.lot_code} relisted`);
      await refresh();
    } catch (error) { setMessage(error.response?.data?.message || 'Unable to relist lot'); }
  };

  const startAuction = async lot => {
    try {
      const token = localStorage.getItem('agripulse_token');
      await axios.post(`${API}/api/v1/lots/${lot.id}/auction`, {}, { headers:{ Authorization:`Bearer ${token}` } });
      setMessage(`Auction created for ${lot.lot_code}`);
      await refresh();
    } catch (error) {
      setMessage(error.response?.data?.message || 'Unable to create auction');
    }
  };

  const submitQuality = async lot => {
    try {
      const token = localStorage.getItem('agripulse_token');
      await axios.post(`${API}/api/v1/lots/${lot.id}/quality`, {
        moisturePct: lot.moisture_pct,
        grade: lot.grade,
        foreignMatterPct: Number(foreignMatter),
        brokenGrainPct: Number(brokenGrain),
        certificateNo: `Q-${lot.lot_code}`,
        notes: 'Submitted from farmer mobile quality form'
      }, { headers:{ Authorization:`Bearer ${token}` } });
      setMessage(`Quality assessment submitted for ${lot.lot_code}`);
      await refresh();
    } catch (error) {
      setMessage(error.response?.data?.message || 'Quality submission failed');
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Fair-Price Calculator</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-sm font-semibold">Crop<select value={crop} onChange={e=>setCrop(e.target.value)} className="mt-1 w-full rounded border p-2">{crops.map(c=><option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          <label className="text-sm font-semibold">District<select value={district} onChange={e=>setDistrict(e.target.value)} className="mt-1 w-full rounded border p-2">{districts.map(d=><option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
          <label className="text-sm font-semibold">Grade<select value={grade} onChange={e=>setGrade(e.target.value)} className="mt-1 w-full rounded border p-2"><option>A</option><option>B</option><option>C</option></select></label>
          <label className="text-sm font-semibold">Moisture %<input type="number" min="0" max="45" value={moisture} onChange={e=>setMoisture(e.target.value)} className="mt-1 w-full rounded border p-2"/></label>
        </div>
        {calculated && <div className="mt-5 rounded-xl bg-emerald-50 p-4">
          <p className="text-sm text-slate-600">Recommended floor</p>
          <p className="text-3xl font-black text-emerald-800">₹{calculated.floorPrice.toFixed(2)}</p>
          <p className="mt-2 text-xs text-slate-600">Mandi ₹{calculated.modal} · MSP ₹{calculated.msp} · Moisture penalty ₹{calculated.penalty}</p>
          <p className="mt-1 text-[11px] text-slate-500">{calculated.source}{calculated.updatedAt ? ` · ${new Date(calculated.updatedAt).toLocaleString()}` : ''}</p>
        </div>}
        {nearbyPrices.length > 0 && <div className="mt-4 rounded-lg border p-3">
          <p className="text-sm font-black">Nearby mandi prices</p>
          <div className="mt-2 space-y-1">{nearbyPrices.map(price => <div key={price.districtId} className="flex justify-between text-xs"><span>{price.districtId}</span><b>₹{price.mandiModalInr}</b></div>)}</div>
        </div>}
      </section>
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Register Harvest Lot</h2>
        <form onSubmit={registerLot} className="mt-4 space-y-3">
          <input type="number" min="1" max="2000" required value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="Quantity in quintals" className="w-full rounded border p-3"/>
          <div className="grid grid-cols-2 gap-3">
            <input type="number" min="0" max="100" required value={foreignMatter} onChange={e=>setForeignMatter(e.target.value)} placeholder="Foreign matter %" className="w-full rounded border p-3"/>
            <input type="number" min="0" max="100" required value={brokenGrain} onChange={e=>setBrokenGrain(e.target.value)} placeholder="Broken grain %" className="w-full rounded border p-3"/>
          </div>
          <input type="file" accept="image/*" capture="environment" onChange={capturePhoto} className="w-full rounded border p-2 text-sm"/>
          {capturedPhoto && <img src={capturedPhoto} alt="Lot preview" className="h-28 w-full rounded object-cover"/>}
          <button className="w-full rounded-lg bg-emerald-700 py-3 font-bold text-white">Save & Sync Lot</button>
        </form>
        {message && <p className="mt-3 text-sm font-semibold text-emerald-700">{message}</p>}
      </section>
      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">Sync Queue</h2><button onClick={retryQueue} className="text-xs font-bold text-emerald-800">Retry All</button></div>
        <div className="mt-3 space-y-2">{queue.map(r=><div key={r.localId} className="rounded-lg border p-3 text-sm"><b>{r.cropCode}</b> · {r.quantityQuintals}q <span className={`float-right rounded px-2 py-1 text-xs ${r.syncStatus==='ERROR'?'bg-red-100 text-red-700':'bg-amber-100 text-amber-800'}`}>{r.syncStatus}</span>{r.lastError&&<p className="mt-1 text-xs text-red-600">{r.lastError}</p>}</div>)}</div>
      </section>
      <section className="lg:col-span-3 rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">My Lots & Sync Queue</h2><button onClick={exportCsv} className="rounded-lg border px-3 py-2 text-sm font-bold">CSV Export</button></div>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-2">Lot</th><th>Crop</th><th>Quantity</th><th>Status</th><th>Quality</th><th>Actions</th></tr></thead><tbody>{lots.map(l=><tr key={l.id} className="border-b"><td className="py-3">{l.lot_code}</td><td>{l.crop_code}</td><td>{l.quantity_quintals} q</td><td><span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-bold">{l.status}</span></td><td>{l.quality_card?.assessmentStatus === 'VERIFIED' ? <span className="font-bold text-emerald-700">Verified</span> : <button onClick={()=>submitQuality(l)} className="rounded border border-emerald-700 px-2 py-1 text-xs font-bold text-emerald-800">Submit Quality</button>}</td><td className="space-x-2">{l.status === 'LISTED' && l.quality_card?.assessmentStatus === 'VERIFIED' && <button onClick={()=>startAuction(l)} className="text-xs font-bold text-emerald-700">List for auction</button>}{['LISTED','POOLED','DRAFT'].includes(l.status) ? <button onClick={()=>cancelLot(l)} className="text-xs font-bold text-red-700">Cancel</button> : l.status === 'CANCELED' ? <button onClick={()=>relistLot(l)} className="text-xs font-bold text-emerald-700">Relist</button> : null}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
