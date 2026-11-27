import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function AdminDashboard() {
  const [accounts, setAccounts] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [logisticsUsers, setLogisticsUsers] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [crops, setCrops] = useState([]);
  const [districtId, setDistrictId] = useState('GWALIOR');
  const [cropCode, setCropCode] = useState('WHEAT');
  const [modalPrice, setModalPrice] = useState('');
  const [mspPrice, setMspPrice] = useState('');
  const [arrival, setArrival] = useState('');
  const [assignments, setAssignments] = useState({});
  const [message, setMessage] = useState('');
  const token = localStorage.getItem('agripulse_token');
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const selectedDistrictId = districtId || districts[0]?.code || '';
  const selectedCropCode = cropCode || crops[0]?.code || '';

  const load = useCallback(async () => {
    try {
      const [accountsResponse, dispatchResponse, masterResponse] = await Promise.all([
        axios.get(`${API}/api/v1/admin/accounts`, { headers }),
        axios.get(`${API}/api/v1/dispatches`, { headers }),
        axios.get(`${API}/api/v1/master-data`)
      ]);
      setAccounts(accountsResponse.data.accounts);
      setDispatches(dispatchResponse.data.dispatches);
      setLogisticsUsers(accountsResponse.data.accounts.filter(account => account.role === 'LOGISTICS' && account.account_status === 'APPROVED'));
      setDistricts(masterResponse.data.districts);
      setCrops(masterResponse.data.crops);
    } catch (error) {
      setMessage(error.response?.data?.message || 'Unable to load administrator data');
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedDistrictId || !selectedCropCode) return;
    axios.get(`${API}/api/v1/advisory/fair-price`, {
      params: { cropCode:selectedCropCode, districtId:selectedDistrictId, grade: 'A', moisturePct: 11 }
    }).then(response => {
      setModalPrice(response.data.mandiModalInr);
      setMspPrice(response.data.mspInr);
    }).catch(error => setMessage(error.response?.data?.message || 'Unable to load mandi pricing'));
    axios.get(`${API}/api/v1/advisory/nearby-prices`, { params: { cropCode:selectedCropCode, districtId:selectedDistrictId } })
      .then(response => {
        const price = response.data.prices.find(item => item.districtId === selectedDistrictId);
        setArrival(price?.arrivalQuintals ?? '');
      }).catch(() => {});
  }, [selectedDistrictId, selectedCropCode]);

  const updateAccount = async (account, field, value) => {
    try {
      const path = field === 'accountStatus' ? 'approval' : 'kyc';
      await axios.patch(`${API}/api/v1/admin/accounts/${account.id}/${path}`, { [field]: value }, { headers });
      setMessage(`${account.full_name}: ${field === 'accountStatus' ? 'account' : 'KYC'} updated`);
      await load();
    } catch (error) {
      setMessage(error.response?.data?.message || 'Account update failed');
    }
  };

  const savePrice = async event => {
    event.preventDefault();
    try {
      await axios.put(`${API}/api/v1/admin/mandi-prices/${selectedDistrictId}/${selectedCropCode}`, {
        modalPriceInr: Number(modalPrice),
        mspInr: Number(mspPrice),
        arrivalQuintals: Number(arrival || 0),
        source: 'Administrator manual update'
      }, { headers });
      setMessage(`Saved price for ${selectedCropCode} in ${selectedDistrictId}. This is a manual price, not a live feed.`);
    } catch (error) {
      setMessage(error.response?.data?.message || 'Price update failed');
    }
  };

  const assignDispatch = async dispatch => {
    const assignment = assignments[dispatch.id] || {};
    if (!assignment.logisticsUserId || !assignment.vehicleNumber) {
      setMessage('Select an approved logistics account and enter the vehicle number.');
      return;
    }
    try {
      await axios.post(`${API}/api/v1/dispatches/${dispatch.id}/assign`, {
        logisticsUserId: Number(assignment.logisticsUserId),
        vehicleNumber: assignment.vehicleNumber
      }, { headers });
      setMessage(`Dispatch #${dispatch.id} assigned. A delivery OTP was sent to the buyer's in-app notifications.`);
      await load();
    } catch (error) {
      setMessage(error.response?.data?.message || 'Dispatch assignment failed');
    }
  };

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-bold text-emerald-700">Operations</p>
        <h1 className="text-3xl font-black">Administrator Dashboard</h1>
        {message && <p role="status" className="mt-2 text-sm font-semibold text-emerald-800">{message}</p>}
      </div>

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Account approvals and KYC</h2>
        <p className="mt-1 text-xs text-amber-800">KYC documents are not collected here. Verify KYC only after completing the external identity review.</p>
        <div className="mt-4 space-y-3">
          {accounts.map(account => <article key={account.id} className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 text-sm">
            <div><b>{account.full_name}</b> · {account.role} · {account.phone}<p className="text-xs text-slate-500">{account.district_id} · Account {account.account_status} · KYC {account.kyc_status}</p></div>
            <div className="flex gap-2">
              {account.account_status === 'PENDING' && <>
                <button onClick={() => updateAccount(account, 'accountStatus', 'APPROVED')} className="rounded bg-emerald-700 px-3 py-2 text-xs font-bold text-white">Approve</button>
                <button onClick={() => updateAccount(account, 'accountStatus', 'REJECTED')} className="rounded border border-red-300 px-3 py-2 text-xs font-bold text-red-700">Reject</button>
              </>}
              {account.kyc_status !== 'VERIFIED' && account.kyc_status !== 'REJECTED' && <button onClick={() => updateAccount(account, 'kycStatus', 'VERIFIED')} className="rounded border px-3 py-2 text-xs font-bold">Verify KYC</button>}
            </div>
          </article>)}
          {!accounts.length && <p className="text-sm text-slate-500">No accounts to review.</p>}
        </div>
      </section>

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Mandi price management</h2>
        <p className="mt-1 text-xs text-amber-800">Prices are manually maintained. A live AGMARKNET integration is not configured.</p>
        <form onSubmit={savePrice} className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <select aria-label="Price district" value={selectedDistrictId} onChange={event => setDistrictId(event.target.value)} className="rounded border p-2">{districts.map(district => <option key={district.code} value={district.code}>{district.name}</option>)}</select>
          <select aria-label="Price crop" value={selectedCropCode} onChange={event => setCropCode(event.target.value)} className="rounded border p-2">{crops.map(crop => <option key={crop.code} value={crop.code}>{crop.name}</option>)}</select>
          <input aria-label="Mandi modal price" type="number" min="0" step="0.01" value={modalPrice} onChange={event => setModalPrice(event.target.value)} required className="rounded border p-2" placeholder="Modal price" />
          <input aria-label="MSP price" type="number" min="0" step="0.01" value={mspPrice} onChange={event => setMspPrice(event.target.value)} required className="rounded border p-2" placeholder="MSP" />
          <button className="rounded bg-emerald-700 px-4 py-2 font-bold text-white">Save manual price</button>
        </form>
        <label className="mt-3 block text-sm">Arrival quintals
          <input type="number" min="0" step="0.01" value={arrival} onChange={event => setArrival(event.target.value)} className="ml-3 rounded border p-2" />
        </label>
      </section>

      <section className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-black">Dispatch assignment</h2>
        <div className="mt-4 space-y-3">
          {dispatches.map(dispatch => <article key={dispatch.id} className="grid gap-3 border-b pb-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-center">
            <div className="text-sm"><b>Dispatch #{dispatch.id}</b><p className="text-xs text-slate-500">{dispatch.logistics_status} · {dispatch.vehicle_number || 'No vehicle assigned'}</p></div>
            <select aria-label={`Logistics account for dispatch ${dispatch.id}`} value={assignments[dispatch.id]?.logisticsUserId || dispatch.logistics_user_id || ''} onChange={event => setAssignments(current => ({ ...current, [dispatch.id]: { ...current[dispatch.id], logisticsUserId: event.target.value } }))} className="rounded border p-2">
              <option value="">Select logistics account</option>
              {logisticsUsers.map(userOption => <option key={userOption.id} value={userOption.id}>{userOption.full_name} · {userOption.district_id}</option>)}
            </select>
            <input aria-label={`Vehicle number for dispatch ${dispatch.id}`} value={assignments[dispatch.id]?.vehicleNumber ?? dispatch.vehicle_number ?? ''} onChange={event => setAssignments(current => ({ ...current, [dispatch.id]: { ...current[dispatch.id], vehicleNumber: event.target.value } }))} placeholder="Vehicle number" className="rounded border p-2" />
            <button onClick={() => assignDispatch(dispatch)} disabled={dispatch.logistics_status !== 'PENDING_PICKUP'} className="rounded bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">Assign</button>
          </article>)}
          {!dispatches.length && <p className="text-sm text-slate-500">No dispatches awaiting assignment.</p>}
        </div>
      </section>
    </section>
  );
}
