import axios from 'axios';
import { db } from '../db/offlineDb';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export async function syncPendingLots() {
  if (!navigator.onLine) return { synced: 0, pending: await db.pendingLots.count() };
  const token = localStorage.getItem('agripulse_token');
  const [pending, retryableErrors] = await Promise.all([
    db.pendingLots.where('syncStatus').equals('PENDING').toArray(),
    db.pendingLots.where('syncStatus').equals('ERROR').toArray()
  ]);
  const records = [...pending, ...retryableErrors.filter(r => r.retryAfter ? r.retryAfter <= Date.now() : true)];
  let synced = 0;
  for (let i = 0; i < records.length; i += 50) {
    const chunk = records.slice(i, i + 50);
    try {
      const response = await axios.post(`${API}/api/v1/lots/sync`, {
        lots: chunk.map(r => ({
          clientEventId: r.clientEventId,
          cropCode: r.cropCode,
          quantityQuintals: r.quantityQuintals,
          moisturePct: r.moisturePct,
          grade: r.grade,
          districtId: r.districtId,
          capturedAt: r.capturedAt,
          captureLatitude: r.captureLatitude,
          captureLongitude: r.captureLongitude,
          qualityCard: r.qualityCard || {}
        }))
      }, { headers: { Authorization: `Bearer ${token}` } });
      const processedIds = new Set([
        ...response.data.syncedLots.map(l => l.client_event_id),
        ...chunk.filter(r => response.data.errors.every(e => e.clientEventId !== r.clientEventId)).map(r => r.clientEventId)
      ]);
      for (const record of chunk) {
        if (processedIds.has(record.clientEventId)) await db.pendingLots.delete(record.localId);
      }
      for (const error of response.data.errors || []) {
        const record = chunk.find(r => r.clientEventId === error.clientEventId);
        if (record) await db.pendingLots.update(record.localId, {
          syncStatus: 'ERROR',
          lastError: error.message,
          retryAfter: Date.now() + 60000,
          attemptCount: (record.attemptCount || 0) + 1
        });
      }
      for (const record of chunk) {
        if (response.data.errors?.some(error => error.clientEventId === record.clientEventId)) continue;
        await db.pendingLots.update(record.localId, { syncStatus:'PENDING', lastError:'' });
      }
      synced += response.data.syncedCount;
    } catch (error) {
      const message = error.response?.data?.message || error.message || 'Network sync failed';
      await Promise.all(chunk.map(r => db.pendingLots.update(r.localId, {
        syncStatus: 'ERROR',
        lastError: message,
        retryAfter: Date.now() + 60000,
        attemptCount: (r.attemptCount || 0) + 1
      })));
    }

  }
  return { synced, pending: await db.pendingLots.count() };
}

export async function retryAllPendingLots() {
  const errors = await db.pendingLots.where('syncStatus').equals('ERROR').toArray();
  await Promise.all(errors.map(record => db.pendingLots.update(record.localId, {
    syncStatus: 'PENDING',
    lastError: '',
    retryAfter: null
  })));
  return syncPendingLots();
}

export function startSyncManager(onChange) {
  const run = async () => onChange?.(await syncPendingLots());
  window.addEventListener('online', run);
  run();
  const interval = window.setInterval(run, 15000);
  return () => {
    window.removeEventListener('online', run);
    window.clearInterval(interval);
  };
}
