require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const createApp = require('./app');

const httpServer = http.createServer();
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const app = createApp(io);
httpServer.removeAllListeners('request');
httpServer.on('request', app);

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32)) {
  throw new Error('JWT_SECRET of at least 32 bytes is required in production');
}

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => console.log(`AgriPulse API listening on port ${port}`));

const { pool } = require('./config/db');
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE auctions SET status='CLOSED'
       WHERE status='OPEN' AND ends_at<=NOW()
       RETURNING id,lot_id,highest_bidder_id`
    );
    for (const auction of result.rows) {
      if (!auction.highest_bidder_id) {
        await pool.query(`UPDATE crop_lots SET status='LISTED' WHERE id=$1 AND status='IN_AUCTION'`, [auction.lot_id]);
      }
      io.emit('auction:closed', { auctionId:auction.id, lotId:auction.lot_id, expired:true });
    }
  } catch (error) {
    console.error('Auction expiry worker failed:', error.message);
  }
}, 30000).unref();
