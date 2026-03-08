const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ══════════════════════════════════════════
// מבני נתונים
// ══════════════════════════════════════════

// חדרים פעילים: { roomId: Room }
const rooms = {};

// תור המתנה לmatchmaking: [{ socketId, player }]
let waitingQueue = [];

function makeRoom(id) {
  return {
    id,
    players: {},      // { socketId: { name, avatar, color } }
    spectators: [],
    gameState: null,
    createdAt: Date.now()
  };
}

// ══════════════════════════════════════════
// עזרים
// ══════════════════════════════════════════

function getRoomPlayers(room) {
  return Object.values(room.players);
}

function isFull(room) {
  return Object.keys(room.players).length >= 2;
}

function getOpponent(room, socketId) {
  return Object.keys(room.players).find(id => id !== socketId);
}

// ══════════════════════════════════════════
// Socket.io
// ══════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`✅ התחבר: ${socket.id}`);

  // ── יצירת חדר (קוד חדר) ──
  socket.on('create_room', ({ name, avatar }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms[roomId] = makeRoom(roomId);
    rooms[roomId].players[socket.id] = {
      name: name || 'שחקן 1',
      avatar: avatar || null,
      color: 'w'  // יוצר החדר = לבן
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId });
    console.log(`🏠 חדר נוצר: ${roomId} על ידי ${name}`);
  });

  // ── הצטרפות לחדר (קוד חדר) ──
  socket.on('join_room', ({ roomId, name, avatar }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', { msg: 'חדר לא נמצא' });
      return;
    }
    if (isFull(room)) {
      socket.emit('error', { msg: 'החדר מלא' });
      return;
    }

    room.players[socket.id] = {
      name: name || 'שחקן 2',
      avatar: avatar || null,
      color: 'k'  // מצטרף = שחור
    };
    socket.join(roomId);
    socket.roomId = roomId;

    // שלח לשניהם שהמשחק מתחיל
    const players = getRoomPlayers(room);
    io.to(roomId).emit('game_start', {
      roomId,
      players: Object.entries(room.players).map(([sid, p]) => ({
        socketId: sid,
        name: p.name,
        avatar: p.avatar,
        color: p.color
      }))
    });
    console.log(`🎮 משחק התחיל בחדר: ${roomId}`);
  });

  // ── Matchmaking ──
  socket.on('find_match', ({ name, avatar }) => {
    // הסר מהתור אם כבר נמצא
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);

    if (waitingQueue.length > 0) {
      // יש מישהו מחכה — צור חדר עם השניים
      const opponent = waitingQueue.shift();
      const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms[roomId] = makeRoom(roomId);

      // יריב = לבן (מחכה ראשון)
      rooms[roomId].players[opponent.socketId] = {
        name: opponent.name,
        avatar: opponent.avatar || null,
        color: 'w'
      };
      // אני = שחור
      rooms[roomId].players[socket.id] = {
        name: name || 'שחקן',
        avatar: avatar || null,
        color: 'k'
      };

      const opponentSocket = io.sockets.sockets.get(opponent.socketId);
      if (opponentSocket) {
        opponentSocket.join(roomId);
        opponentSocket.roomId = roomId;
      }
      socket.join(roomId);
      socket.roomId = roomId;

      const playersArr = Object.entries(rooms[roomId].players).map(([sid, p]) => ({
        socketId: sid,
        name: p.name,
        avatar: p.avatar,
        color: p.color
      }));

      io.to(roomId).emit('game_start', { roomId, players: playersArr });
      console.log(`🔀 Matchmaking: ${opponent.name} vs ${name} → חדר ${roomId}`);
    } else {
      // הכנס לתור
      waitingQueue.push({ socketId: socket.id, name: name || 'שחקן', avatar });
      socket.emit('waiting_for_opponent');
      console.log(`⏳ ממתין: ${name}`);
    }
  });

  // ── ביטול חיפוש ──
  socket.on('cancel_find', () => {
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);
    socket.emit('find_cancelled');
  });

  // ══════════════════════════════════════════
  // אירועי משחק — מועברים ישירות ליריב
  // ══════════════════════════════════════════

  // זריקת קוביות
  socket.on('roll', ({ dice }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_roll', { dice });
  });

  // הזזת כלי
  socket.on('move', ({ mv }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_move', { mv });
  });

  // סיום תור
  socket.on('end_turn', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_end_turn');
  });

  // הצעת כפל (doubling cube)
  socket.on('double_offer', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_double_offer');
  });

  socket.on('double_response', ({ accepted }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_double_response', { accepted });
  });

  // ניצחון
  socket.on('game_over', ({ winner }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_game_over', { winner });
  });

  // צ'אט קצר (אמוג'י/ביטויים)
  socket.on('chat', ({ msg }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponent_chat', { msg });
  });

  // ── ניתוק ──
  socket.on('disconnect', () => {
    console.log(`❌ התנתק: ${socket.id}`);

    // הסר מתור matchmaking
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);

    // עדכן יריב בחדר
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      socket.to(roomId).emit('opponent_disconnected');
      delete rooms[roomId].players[socket.id];
      // אם החדר ריק — מחק
      if (Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
        console.log(`🗑️ חדר נמחק: ${roomId}`);
      }
    }
  });
});

// ══════════════════════════════════════════
// Serve game HTML
// ══════════════════════════════════════════
const path = require('path');
const fs = require('fs');

app.get('/', (req, res) => {
  const gamePath = path.join(__dirname, 'game.html');
  if(fs.existsSync(gamePath)){
    res.sendFile(gamePath);
  } else {
    res.json({ status: 'ok', rooms: Object.keys(rooms).length, waiting: waitingQueue.length });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length, waiting: waitingQueue.length, uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎲 שרת שש-בש פועל על פורט ${PORT}`);
});
