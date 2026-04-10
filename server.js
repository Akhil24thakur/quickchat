const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { customAlphabet } = require('nanoid');

const app = express(); // create app FIRST
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

/* ================= STATIC FILES ================= */

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ================= DATABASE (memory) ================= */

const roomsDb = new Map();
const messagesDb = new Map();

/* ================= FILTER ================= */

const bannedWords = [
  'damn','hell','crap','idiot','stupid','bitch','asshole','fuck','shit'
];

function censorBadWords(text){
  const pattern = new RegExp(`\\b(${bannedWords.join('|')})\\b`,'gi');
  return text.replace(pattern, word => '*'.repeat(word.length));
}

function sanitizeUsername(name){
  const trimmed = (name || '').trim().slice(0,30);
  if(!trimmed) return '';

  if(new RegExp(`\\b(${bannedWords.join('|')})\\b`,'i').test(trimmed)){
    return '';
  }

  return trimmed;
}

function guestNameFromIp(ip){
  const suffix =
    (ip || '')
    .replace(/^.*:/,'')
    .replace(/\D/g,'');

  return `Guest-${suffix.slice(-4) || Math.floor(Math.random()*9000)}`;
}

/* ================= ROOM ID ================= */

const nanoid = customAlphabet(
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789',
  8
);

function createRoom(){

  let id;

  do{
    id = nanoid();
  }
  while(roomsDb.has(id));

  const expires =
    Math.floor(Date.now()/1000) + 86400;

  roomsDb.set(id,{expires_at:expires});
  messagesDb.set(id,[]);

  return id;
}

function roomExists(id){

  const room = roomsDb.get(id);

  if(!room) return false;

  if(room.expires_at < Math.floor(Date.now()/1000)){
    roomsDb.delete(id);
    messagesDb.delete(id);
    return false;
  }

  return true;
}

/* ================= USERS ================= */

const rooms = {};
const socketMeta = {};

function getUserCount(roomId){

  return rooms[roomId]
    ? rooms[roomId].size
    : 0;

}

/* ================= ROUTES ================= */

app.get('/', (req,res)=>{

  res.sendFile(
    path.join(__dirname,'public','index.html')
  );

});

app.get('/room/:id',(req,res)=>{

  if(!roomExists(req.params.id)){

    return res.redirect('/?error=notfound');

  }

  res.sendFile(
    path.join(__dirname,'public','room.html')
  );

});

app.get('/api/guest-name',(req,res)=>{

  const ip =
    req.ip ||
    req.socket.remoteAddress ||
    '';

  res.json({
    guestName: guestNameFromIp(ip)
  });

});

app.post('/api/create-room',(req,res)=>{

  const id = createRoom();

  res.json({
    roomId:id
  });

});

app.get('/api/room/:id',(req,res)=>{

  if(!roomExists(req.params.id)){

    return res.status(404).json({
      error:'Room expired'
    });

  }

  res.json({

    exists:true,
    roomId:req.params.id,
    online:getUserCount(req.params.id)

  });

});

/* ================= SOCKET ================= */

io.on('connection',(socket)=>{

  socket.on('join-room',({roomId,username})=>{

    if(!roomExists(roomId)){

      socket.emit('error',{
        message:'Room expired'
      });

      return;

    }

    const cleanName =
      sanitizeUsername(username);

    if(!cleanName){

      socket.emit('error',{
        message:'Invalid username'
      });

      return;

    }

    socket.join(roomId);

    if(!rooms[roomId])
      rooms[roomId] = new Set();

    rooms[roomId].add(socket.id);

    socketMeta[socket.id] = {

      roomId,
      username: cleanName

    };

    socket.emit('joined',{
      username:cleanName
    });

    socket.to(roomId).emit(
      'user-joined',
      {username:cleanName}
    );

    io.to(roomId).emit(
      'user-count',
      getUserCount(roomId)
    );

  });

  socket.on(
    'send-message',
    ({roomId,username,text})=>{

      if(!roomExists(roomId)) return;

      const cleanText =
        censorBadWords(
          text.trim().slice(0,1000)
        );

      if(!cleanText) return;

      const ts =
        Math.floor(Date.now()/1000);

      if(!messagesDb.has(roomId))
        messagesDb.set(roomId,[]);

      messagesDb
      .get(roomId)
      .push({

        username,
        text:cleanText,
        sent_at:ts

      });

      io.to(roomId).emit(
        'new-message',
        {

          username,
          text:cleanText,
          sent_at:ts

        }
      );

  });

  socket.on(
    'typing',
    ({roomId,username})=>{

      socket
      .to(roomId)
      .emit('typing',{username});

  });

  socket.on(
    'stop-typing',
    ({roomId})=>{

      socket
      .to(roomId)
      .emit('stop-typing');

  });

  socket.on('disconnect',()=>{

    const meta =
      socketMeta[socket.id];

    if(!meta) return;

    const {roomId,username} = meta;

    rooms[roomId]?.delete(socket.id);

    delete socketMeta[socket.id];

    io.to(roomId)
    .emit('user-left',{username});

    io.to(roomId)
    .emit('user-count',
      getUserCount(roomId)
    );

  });

});

/* ================= CLEANUP ================= */

setInterval(()=>{

  const now =
    Math.floor(Date.now()/1000);

  for(const [id,room] of roomsDb){

    if(room.expires_at < now){

      roomsDb.delete(id);
      messagesDb.delete(id);

    }

  }

},3600*1000);

/* ================= START ================= */

const PORT =
  process.env.PORT || 3000;

server.listen(PORT,()=>{

  console.log(
    "🚀 QuickChat running on port",
    PORT
  );

});