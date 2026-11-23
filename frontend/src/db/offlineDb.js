import Dexie from 'dexie';

export const db = new Dexie('AgriPulseDB');
db.version(1).stores({
  pendingLots: '++localId, clientEventId, cropCode, districtId, syncStatus',
  mandiCache: '[districtId+cropCode], cachedAt'
});
