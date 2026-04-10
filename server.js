const express = require('express');
app.use(express.static("public"));
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { customAlphabet } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ─── In-memory storage setup ──────────────────────────────────────────────────
const roomsDb = new Map(); // roomId -> { expires_at }
const messagesDb = new Map(); // roomId -> Array<{ username, text, sent_at }>

const bannedWords = [
  'damn', 'hell', 'crap', 'idiot', 'stupid', 'bitch', 'asshole', 'fuck', 'shit'
];

function censorBadWords(text) {
  const pattern = new RegExp(`\\b(${bannedWords.join('|')})\\b`, 'gi');
  return text.replace(pattern, (word) => '*'.repeat(word.length));
}

function sanitizeUsername(name) {
  const trimmed = (name || '').trim().slice(0, 30);
  if (!trimmed) return '';
  if (new RegExp(`\\b(${bannedWords.join('|')})\\b`, 'i').test(trimmed)) return '';
  return trimmed;
}

function guestNameFromIp(ip) {
  const suffix = (ip || '').replace(/^.*:/, '').replace(/\D/g, '') || String(Math.floor(Math.random() * 9000) + 1000);
  return `Guest-${suffix.slice(-4)}`;
}

// ─── Room ID generator ────────────────────────────────────────────────────────
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', 8);

function createRoom() {
  let id;
  do { id = nanoid(); } while (roomsDb.has(id));
  // Rooms expire after 24 hours
  const expires = Math.floor(Date.now() / 1000) + 86400;
  roomsDb.set(id, { expires_at: expires });
  messagesDb.set(id, []);
  return id;
}

function roomExists(id) {
  const room = roomsDb.get(id);
  if (!room) return false;
  if (room.expires_at && room.expires_at < Math.floor(Date.now() / 1000)) {
    roomsDb.delete(id);
    messagesDb.delete(id);
    return false;
  }
  return true;
}

function getMessages(roomId, limit = 50) {
  const messages = messagesDb.get(roomId) || [];
  return messages.slice(-limit);
}

function saveMessage(roomId, username, text) {
  if (!messagesDb.has(roomId)) messagesDb.set(roomId, []);
  messagesDb.get(roomId).push({ username, text, sent_at: Math.floor(Date.now() / 1000) });
}

// ─── Track online users per room ─────────────────────────────────────────────
const rooms = {}; // { roomId: Set<socketId> }
const socketMeta = {}; // { socketId: { roomId, username } }

function getUserCount(roomId) {
  return rooms[roomId] ? rooms[roomId].size : 0;
}

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/room/:id', (req, res) => {
  if (!roomExists(req.params.id)) {
    return res.redirect('/?error=notfound');
  }
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/guest-name', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  res.json({ guestName: guestNameFromIp(ip) });
});

app.post('/api/create-room', (req, res) => {
  const id = createRoom();
  res.json({ roomId: id });
});

app.get('/api/room/:id', (req, res) => {
  if (!roomExists(req.params.id)) {
    return res.status(404).json({ error: 'Room not found or expired' });
  }
  res.json({ exists: true, roomId: req.params.id, online: getUserCount(req.params.id) });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join-room', ({ roomId, username }) => {
    if (!roomExists(roomId)) {
      socket.emit('error', { message: 'Room not found or has expired.' });
      return;
    }

    const cleanName = sanitizeUsername(username);
    if (!cleanName) {
      socket.emit('error', { message: 'Please choose a clean display name without profanity.' });
      return;
    }

    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = new Set();
    rooms[roomId].add(socket.id);
    socketMeta[socket.id] = { roomId, username: cleanName };

    // Do not send previous conversation to new joiners
    socket.emit('joined', { username: cleanName });

    // Notify others
    socket.to(roomId).emit('user-joined', { username: cleanName });

    // Broadcast updated user count
    io.to(roomId).emit('user-count', getUserCount(roomId));
  });

  socket.on('send-message', ({ roomId, username, text }) => {
    if (!roomExists(roomId)) return;
    const cleanText = censorBadWords(text.trim().slice(0, 1000));
    if (!cleanText) return;

    const ts = Math.floor(Date.now() / 1000);
    saveMessage(roomId, username, cleanText);

    io.to(roomId).emit('new-message', { username, text: cleanText, sent_at: ts });
  });

  socket.on('typing', ({ roomId, username }) => {
    socket.to(roomId).emit('typing', { username });
  });

  socket.on('stop-typing', ({ roomId }) => {
    socket.to(roomId).emit('stop-typing');
  });

  socket.on('disconnect', () => {
    const meta = socketMeta[socket.id];
    if (meta) {
      const { roomId, username } = meta;
      if (rooms[roomId]) {
        rooms[roomId].delete(socket.id);
        if (rooms[roomId].size === 0) delete rooms[roomId];
      }
      delete socketMeta[socket.id];
      io.to(roomId).emit('user-left', { username });
      io.to(roomId).emit('user-count', getUserCount(roomId));
    }
  });
});

// ─── Clean up expired rooms every hour ───────────────────────────────────────
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, room] of roomsDb.entries()) {
    if (room.expires_at && room.expires_at < now) {
      roomsDb.delete(id);
      messagesDb.delete(id);
    }
  }
}, 3600 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ QuickChat running at http://localhost:${PORT}\n`);
});
