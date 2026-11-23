import { useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function AccountSettings({ user, onUpdated }) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState(user.fullName);
  const [districtId, setDistrictId] = useState(user.districtId);
  const [preferredLang, setPreferredLang] = useState(user.preferredLang || 'en');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const token = localStorage.getItem('agripulse_token');
  const headers = { Authorization: `Bearer ${token}` };

  const saveProfile = async event => {
    event.preventDefault();
    setMessage('');
    try {
      const response = await axios.patch(`${API}/api/v1/auth/me`, { fullName, districtId, preferredLang }, { headers });
      localStorage.setItem('agripulse_user', JSON.stringify(response.data.user));
      onUpdated(response.data.user);
      setMessage('Profile updated');
    } catch (error) {
      setMessage(error.response?.data?.message || 'Unable to update profile');
    }
  };

  const changePassword = async event => {
    event.preventDefault();
    setMessage('');
    try {
      await axios.post(`${API}/api/v1/auth/change-password`, { currentPassword, newPassword }, { headers });
      setCurrentPassword('');
      setNewPassword('');
      setMessage('Password changed');
    } catch (error) {
      setMessage(error.response?.data?.message || 'Unable to change password');
    }
  };

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Account</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-black">Account Settings</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-2xl leading-none">&times;</button>
            </div>
            {message && <p className="mt-3 rounded bg-emerald-50 p-2 text-sm font-semibold text-emerald-800">{message}</p>}
            <form onSubmit={saveProfile} className="mt-4 space-y-3">
              <label className="block text-sm font-semibold">Full name
                <input required value={fullName} onChange={event => setFullName(event.target.value)} className="mt-1 w-full rounded border p-2"/>
              </label>
              <label className="block text-sm font-semibold">District
                <input required value={districtId} onChange={event => setDistrictId(event.target.value)} className="mt-1 w-full rounded border p-2"/>
              </label>
              <label className="block text-sm font-semibold">Language
                <select value={preferredLang} onChange={event => setPreferredLang(event.target.value)} className="mt-1 w-full rounded border p-2">
                  <option value="en">English</option>
                  <option value="hi">Hindi</option>
                </select>
              </label>
              <button className="w-full rounded bg-emerald-700 py-2 font-bold text-white">Save profile</button>
            </form>
            <form onSubmit={changePassword} className="mt-6 space-y-3 border-t pt-5">
              <h3 className="font-black">Change Password</h3>
              <input required type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} placeholder="Current password" className="w-full rounded border p-2"/>
              <input required type="password" minLength={8} value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="New password" className="w-full rounded border p-2"/>
              <button className="w-full rounded border border-emerald-700 py-2 font-bold text-emerald-800">Change password</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
