import { useEffect, useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function NotificationCenter() {
  const [open,setOpen] = useState(false);
  const [notifications,setNotifications] = useState([]);
  const [unread,setUnread] = useState(0);
  const [preferences,setPreferences] = useState({ in_app:true,sms:false,email:false,push:false });
  const headers={ Authorization:`Bearer ${localStorage.getItem('agripulse_token')}` };

  const load=async()=>{
    try {
      const [notificationResponse,preferencesResponse]=await Promise.all([
        axios.get(`${API}/api/v1/notifications`,{headers}),
        axios.get(`${API}/api/v1/notifications/preferences`,{headers})
      ]);
      setNotifications(notificationResponse.data.notifications);
      setUnread(notificationResponse.data.unreadCount);
      setPreferences(preferencesResponse.data.preferences);
    } catch {}
  };

  useEffect(()=>{
    load();
    const interval=window.setInterval(load,30000);
    return ()=>window.clearInterval(interval);
  },[]);

  const readAll=async()=>{
    await axios.post(`${API}/api/v1/notifications/read-all`,{}, {headers});
    await load();
  };

  const savePreferences=async next=>{
    setPreferences(next);
    await axios.put(`${API}/api/v1/notifications/preferences`,{
      inApp:next.in_app,
      sms:next.sms,
      email:next.email,
      push:next.push,
      quietStart:next.quiet_start,
      quietEnd:next.quiet_end
    },{headers});
  };

  return <div className="relative">
    <button onClick={()=>setOpen(value=>!value)} className="relative rounded-lg border px-3 py-2 text-sm font-bold">
      Notifications
      {unread>0&&<span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">{unread}</span>}
    </button>
    {open&&<div className="absolute right-0 z-50 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl border bg-white p-4 shadow-xl">
      <div className="flex items-center justify-between"><b>Notifications</b><button onClick={readAll} className="text-xs font-bold text-emerald-700">Mark all read</button></div>
      <div className="mt-3 space-y-2">
        {notifications.map(notification=><div key={notification.id} className={`rounded border p-2 ${notification.status==='READ'?'opacity-60':'bg-emerald-50'}`}><p className="text-sm font-bold">{notification.title}</p><p className="text-xs text-slate-600">{notification.body}</p></div>)}
        {!notifications.length&&<p className="text-sm text-slate-500">No notifications</p>}
      </div>
      <div className="mt-4 border-t pt-3">
        <p className="text-xs font-black">Channels</p>
        <label className="mt-1 flex items-center gap-2 text-xs capitalize"><input type="checkbox" checked={preferences.in_app===true} onChange={e=>savePreferences({...preferences,in_app:e.target.checked,sms:false,email:false,push:false})}/>In-app</label>
        <p className="mt-2 text-xs text-slate-500">SMS, email, and push delivery are unavailable until providers are configured.</p>
      </div>
    </div>}
  </div>;
}
