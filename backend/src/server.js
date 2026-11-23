require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const createApp = require('./app');

const httpServer = http.createServer();
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const app = createApp(io);
httpServer.removeAllListeners('request');
httpServer.on('request', app);

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => console.log(`AgriPulse API listening on port ${port}`));
