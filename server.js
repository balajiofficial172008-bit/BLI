const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ─── In-Memory Store ────────────────────────────────────────────────────────

const users = new Map();       // userId → { id, username, passwordHash, createdAt }
const sessions = new Map();    // token → userId
const conversations = new Map(); // convId → { id, participants:[uid,uid], messages:[], accepted:bool, requestFrom:uid|null }
const wsClients = new Map();   // userId → WebSocket

// ─── Seed Demo Users ─────────────────────────────────────────────────────────

async function seedUsers() {
  const demos = [
    { username: 'alice',   password: 'pass123' },
    { username: 'bob',     password: 'pass123' },
    { username: 'charlie', password: 'pass123' },
  ];
  for (const d of demos) {
    const hash = await bcrypt.hash(d.password, 10);
    const id = uuidv4();
    users.set(id, { id, username: d.username, passwordHash: hash, createdAt: Date.now() });
  }
  console.log('✓ Demo users seeded: alice, bob, charlie (password: pass123)');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getUserById(id) { return users.get(id); }
function getUserByUsername(username) {
  for (const u of users.values()) if (u.username === username) return u;
  return null;
}
function getUserByToken(token) {
  const uid = sessions.get(token);
  return uid ? getUserById(uid) : null;
}
function getConvId(uid1, uid2) {
  return [uid1, uid2].sort().join('::');
}
function getOrCreateConv(uid1, uid2, requestFrom = null) {
  const id = getConvId(uid1, uid2);
  if (!conversations.has(id)) {
    conversations.set(id, {
      id,
      participants: [uid1, uid2],
      messages: [],
      accepted: requestFrom === null, // null = both known each other (shouldn't happen at creation)
      requestFrom,
    });
  }
  return conversations.get(id);
}
function safeUser(u) {
  return { id: u.id, username: u.username };
}
function isOnline(uid) { return wsClients.has(uid); }

function sendWS(uid, data) {
  const ws = wsClients.get(uid);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcastPresence(uid) {
  const u = getUserById(uid);
  if (!u) return;
  for (const [otherId] of wsClients) {
    if (otherId === uid) continue;
    sendWS(otherId, {
      type: 'presence',
      userId: uid,
      username: u.username,
      online: isOnline(uid),
      lastSeen: Date.now(),
    });
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3–24 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, _ only' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (getUserByUsername(username)) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  users.set(id, { id, username, passwordHash: hash, createdAt: Date.now() });
  const token = uuidv4();
  sessions.set(token, id);
  res.json({ token, user: safeUser(users.get(id)) });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const u = getUserByUsername(username);
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = uuidv4();
  sessions.set(token, u.id);
  res.json({ token, user: safeUser(u) });
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  const u = getUserByToken(token);
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u;
  next();
}

// Search users
app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const results = [];
  for (const u of users.values()) {
    if (u.id === req.user.id) continue;
    if (u.username.toLowerCase().includes(q)) {
      results.push({ ...safeUser(u), online: isOnline(u.id) });
    }
  }
  res.json(results.slice(0, 10));
});

// Get all conversations for current user
app.get('/api/conversations', auth, (req, res) => {
  const uid = req.user.id;
  const result = [];
  for (const conv of conversations.values()) {
    if (!conv.participants.includes(uid)) continue;
    const otherId = conv.participants.find(p => p !== uid);
    const other = getUserById(otherId);
    if (!other) continue;
    // Count unread: messages not read by me, from the other person
    const unread = conv.messages.filter(m => m.from !== uid && !m.readBy?.includes(uid)).length;
    const lastMsg = conv.messages[conv.messages.length - 1] || null;
    result.push({
      id: conv.id,
      other: { ...safeUser(other), online: isOnline(other.id) },
      accepted: conv.accepted,
      requestFrom: conv.requestFrom,
      unread,
      lastMessage: lastMsg ? { text: lastMsg.text, timestamp: lastMsg.timestamp, from: lastMsg.from } : null,
    });
  }
  res.json(result);
});

// Get messages for a conversation
app.get('/api/messages/:convId', auth, (req, res) => {
  const uid = req.user.id;
  const conv = conversations.get(req.params.convId);
  if (!conv || !conv.participants.includes(uid)) return res.status(403).json({ error: 'Forbidden' });
  res.json(conv.messages.map(m => ({
    id: m.id,
    from: m.from,
    text: m.text,
    timestamp: m.timestamp,
    readBy: m.readBy,
  })));
});

// Accept message request
app.post('/api/conversations/:convId/accept', auth, (req, res) => {
  const uid = req.user.id;
  const conv = conversations.get(req.params.convId);
  if (!conv || !conv.participants.includes(uid)) return res.status(403).json({ error: 'Forbidden' });
  if (conv.requestFrom === uid) return res.status(400).json({ error: 'Cannot accept your own request' });
  conv.accepted = true;
  // Notify both parties
  for (const pid of conv.participants) {
    sendWS(pid, { type: 'conversation_accepted', convId: conv.id });
  }
  res.json({ ok: true });
});

// Decline message request
app.post('/api/conversations/:convId/decline', auth, (req, res) => {
  const uid = req.user.id;
  const conv = conversations.get(req.params.convId);
  if (!conv || !conv.participants.includes(uid)) return res.status(403).json({ error: 'Forbidden' });
  if (conv.requestFrom === uid) return res.status(400).json({ error: 'Cannot decline your own request' });
  conversations.delete(conv.id);
  // Notify the requester
  sendWS(conv.requestFrom, { type: 'request_declined', convId: conv.id });
  res.json({ ok: true });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Auth ──
    if (msg.type === 'auth') {
      const u = getUserByToken(msg.token);
      if (!u) { ws.send(JSON.stringify({ type: 'auth_failed' })); ws.close(); return; }
      currentUser = u;
      // Replace any existing WS for this user
      const old = wsClients.get(u.id);
      if (old && old !== ws && old.readyState === WebSocket.OPEN) old.close();
      wsClients.set(u.id, ws);
      ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser(u) }));
      broadcastPresence(u.id);
      // Send current online statuses of all known contacts
      for (const [uid] of wsClients) {
        if (uid === u.id) continue;
        const contact = getUserById(uid);
        if (contact) {
          ws.send(JSON.stringify({ type: 'presence', userId: uid, username: contact.username, online: true }));
        }
      }
      return;
    }

    if (!currentUser) return;

    // ── Send Message ──
    if (msg.type === 'send_message') {
      const { toUserId, text } = msg;
      if (!text?.trim() || !toUserId) return;
      const toUser = getUserById(toUserId);
      if (!toUser) return;

      const convId = getConvId(currentUser.id, toUserId);
      let conv = conversations.get(convId);
      let isNewRequest = false;

      if (!conv) {
        // New conversation — it's a message request
        conv = getOrCreateConv(currentUser.id, toUserId, currentUser.id);
        isNewRequest = true;
      }

      const message = {
        id: uuidv4(),
        from: currentUser.id,
        text: text.trim().slice(0, 2000),
        timestamp: Date.now(),
        readBy: [currentUser.id], // sender always "read" their own msg
        deleteTimers: {},
      };

      // Only queue if not accepted yet
      if (!conv.accepted && conv.requestFrom !== null) {
        // Queue the message but don't deliver yet if it's pending
        conv.messages.push(message);
        // Send to sender (so they see it as sent)
        sendWS(currentUser.id, {
          type: 'message',
          convId,
          message: { id: message.id, from: message.from, text: message.text, timestamp: message.timestamp, readBy: message.readBy },
        });
        if (isNewRequest) {
          // Notify recipient of new request
          const other = getUserById(toUserId);
          sendWS(toUserId, {
            type: 'message_request',
            conv: {
              id: convId,
              other: { ...safeUser(currentUser), online: isOnline(currentUser.id) },
              accepted: false,
              requestFrom: currentUser.id,
              unread: 1,
              lastMessage: { text: message.text, timestamp: message.timestamp, from: message.from },
            },
          });
        } else {
          sendWS(toUserId, {
            type: 'message',
            convId,
            message: { id: message.id, from: message.from, text: message.text, timestamp: message.timestamp, readBy: message.readBy },
          });
        }
        return;
      }

      conv.messages.push(message);

      // Deliver to both
      const payload = {
        type: 'message',
        convId,
        message: { id: message.id, from: message.from, text: message.text, timestamp: message.timestamp, readBy: message.readBy },
      };
      sendWS(currentUser.id, payload);
      const delivered = sendWS(toUserId, payload);

      // If recipient is online → they'll read it → auto-delete after 1s on read ACK
      // If offline → delete after 5s when they come online and read
      return;
    }

    // ── Read ACK ──
    if (msg.type === 'read') {
      const { convId, messageIds } = msg;
      const conv = conversations.get(convId);
      if (!conv || !conv.participants.includes(currentUser.id)) return;

      for (const mid of (messageIds || [])) {
        const m = conv.messages.find(x => x.id === mid);
        if (!m || m.readBy.includes(currentUser.id)) continue;
        m.readBy.push(currentUser.id);

        // Notify sender that message was read
        const senderId = m.from;
        sendWS(senderId, { type: 'message_read', convId, messageId: mid });
      }
      return;
    }

    // ── Typing ──
    if (msg.type === 'typing') {
      const { toUserId, isTyping } = msg;
      sendWS(toUserId, {
        type: 'typing',
        fromUserId: currentUser.id,
        isTyping,
      });
      return;
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      wsClients.delete(currentUser.id);
      broadcastPresence(currentUser.id);
    }
  });

  ws.on('error', () => {
    if (currentUser) wsClients.delete(currentUser.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
seedUsers().then(() => {
  server.listen(PORT, () => {
    console.log(`\n  ┌────────────────────────────────────────┐`);
    console.log(`  │  CIPHER  ·  Luxury Messaging           │`);
    console.log(`  │  http://localhost:${PORT}                  │`);
    console.log(`  │                                        │`);
    console.log(`  │  Demo accounts (password: pass123):    │`);
    console.log(`  │    alice · bob · charlie               │`);
    console.log(`  └────────────────────────────────────────┘\n`);
  });
});
