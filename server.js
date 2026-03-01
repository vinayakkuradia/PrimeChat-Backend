import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const PORT = process.env.PORT || 8080;

const RENDER_HOSTNAME = process.env.RENDER_EXTERNAL_URL
  ? new URL(process.env.RENDER_EXTERNAL_URL).hostname
  : null;

/* -----------------------------
   UTILITIES
--------------------------------*/

function getWsUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/^http/, "ws");
  }

  const host = req.headers.host;
  return `ws://${host}`;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const { hostname } = new URL(origin);

    if (hostname.endsWith("incognitifier.com")) return true;
    if (RENDER_HOSTNAME && hostname === RENDER_HOSTNAME) return true;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "192.168.1.2"
    )
      return true;

    return false;
  } catch {
    return false;
  }
}

/* -----------------------------
   SERVER SETUP
--------------------------------*/

const server = http.createServer((req, res) => {
  if (req.url === "/_ws") {
    const wsUrl = getWsUrl(req);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ wsUrl }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/* -----------------------------
   DATA STORES
--------------------------------*/

const rooms = new Map();
/*
roomName -> {
  clients: Set<ws>,
  messages: [],
  isPrivate: boolean,
  passcode: string | null,
  hostId: string,
  lastActive: number
}
*/

const waitingUsers = new Set(); // stranger pool

const MAX_MESSAGES_PER_ROOM = 100;

/* -----------------------------
   CLEANUP (private room timeout)
--------------------------------*/

setInterval(() => {
  const now = Date.now();

  for (const [roomName, info] of rooms.entries()) {
    if (
      info.isPrivate &&
      info.clients.size === 0 &&
      now - info.lastActive > 5 * 60 * 1000
    ) {
      rooms.delete(roomName);
      console.log(`Private room ${roomName} deleted (inactive)`);
    }
  }
}, 60 * 1000);

/* -----------------------------
   WEBSOCKET LOGIC
--------------------------------*/

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;

  if (process.env.NODE_ENV === "production" && !isAllowedOrigin(origin)) {
    console.warn("Blocked WS origin:", origin);
    ws.close();
    return;
  }

  ws.username = null;
  ws.room = null;
  ws.userId = randomUUID();

  ws.send(
    JSON.stringify({
      type: "your-id",
      userId: ws.userId,
    }),
  );

  /* -----------------------------
     MESSAGE HANDLER
  --------------------------------*/

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* =============================
       STRANGER MATCHMAKING
    ==============================*/

    if (data.type === "stranger-join") {
      if (ws.room) return;

      // Always set username immediately
      ws.username = data.username;

      const partner = waitingUsers.values().next().value;

      if (partner && partner !== ws) {
        waitingUsers.delete(partner);

        const roomName = `stranger-${randomUUID()}`;

        rooms.set(roomName, {
          clients: new Set(),
          messages: [],
          isPrivate: true,
          passcode: null,
          hostId: ws.userId,
          lastActive: Date.now(),
        });

        ws.room = roomName;
        partner.room = roomName;

        const roomInfo = rooms.get(roomName);
        roomInfo.clients.add(ws);
        roomInfo.clients.add(partner);

        // Send IDs to BOTH
        // ws.send(
        //   JSON.stringify({
        //     type: "your-id",
        //     userId: ws.userId,
        //   }),
        // );

        // partner.send(
        //   JSON.stringify({
        //     type: "your-id",
        //     userId: partner.userId,
        //   }),
        // );

        ws.send(JSON.stringify({ type: "stranger-matched" }));
        partner.send(JSON.stringify({ type: "stranger-matched" }));

        // Notify both users
        broadcastToRoom(roomName, {
          type: "system",
          message: `${ws.username} joined`,
        });

        broadcastToRoom(roomName, {
          type: "system",
          message: `${partner.username} joined`,
        });

        return;
      }

      // No partner → enter waiting pool
      waitingUsers.add(ws);

      ws.send(JSON.stringify({ type: "stranger-waiting" }));
      return;
    }

    /* =============================
       CREATE ROOM
    ==============================*/

    if (data.type === "create-room") {
      const { roomName, isPrivate, passcode } = data;
      if (!roomName) return;

      if (rooms.has(roomName)) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Room already exists",
          }),
        );
        return;
      }

      if (!rooms.has(roomName)) {
        rooms.set(roomName, {
          clients: new Set(),
          messages: [],
          isPrivate: !!isPrivate,
          passcode: isPrivate ? passcode : null,
          hostId: ws.userId,
          lastActive: Date.now(),
        });
      }

      return;
    }

    /* =============================
       LIST ROOMS (public only)
    ==============================*/

    if (data.type === "list-rooms") {
      const publicRooms = [];

      for (const [roomName, info] of rooms.entries()) {
        if (!info.isPrivate) publicRooms.push(roomName);
      }

      ws.send(
        JSON.stringify({
          type: "room-list",
          rooms: publicRooms.slice(0, 25),
        }),
      );

      return;
    }

    /* =============================
       JOIN ROOM
    ==============================*/

    if (data.type === "join") {
      const { username, room, passcode } = data;
      if (!username || !room) return;

      if (!rooms.has(room)) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Room does not exist",
          }),
        );
        return;
      }

      const roomInfo = rooms.get(room);

      if (roomInfo.isPrivate) {
        if (roomInfo.passcode !== passcode) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Invalid passcode",
            }),
          );
          return;
        }
      }

      ws.username = username;
      ws.room = room;

      roomInfo.clients.add(ws);
      roomInfo.lastActive = Date.now();

      ws.send(JSON.stringify({ type: "your-id", userId: ws.userId }));

      roomInfo.messages.forEach((msg) => ws.send(JSON.stringify(msg)));

      // Notify new user about existing users
      for (const client of roomInfo.clients) {
        if (client !== ws && client.username) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: `${client.username} joined`,
            }),
          );
        }
      }

      broadcastToRoom(room, {
        type: "system",
        message: `${username} joined ${room}`,
      });

      return;
    }

    /* =============================
       CHAT MESSAGE
    ==============================*/

    if (data.type === "message") {
      if (!ws.username || !ws.room) return;

      const roomInfo = rooms.get(ws.room);
      if (!roomInfo) return;

      const payload = {
        type: "message",
        username: ws.username,
        userId: ws.userId,
        message: data.message,
      };

      roomInfo.messages.push(payload);

      if (roomInfo.messages.length > MAX_MESSAGES_PER_ROOM) {
        roomInfo.messages.shift();
      }

      roomInfo.lastActive = Date.now();

      broadcastToRoom(ws.room, payload);
      return;
    }
  });

  /* -----------------------------
     DISCONNECT
  --------------------------------*/

  ws.on("close", () => {
    waitingUsers.delete(ws);

    if (!ws.username || !ws.room) return;

    const roomInfo = rooms.get(ws.room);
    if (!roomInfo) return;

    roomInfo.clients.delete(ws);
    roomInfo.lastActive = Date.now();

    broadcastToRoom(ws.room, {
      type: "system",
      message: `${ws.username} left the chat`,
    });

    if (roomInfo.clients.size === 0 && !roomInfo.isPrivate) {
      rooms.delete(ws.room);
    }
  });
});

/* -----------------------------
   BROADCAST HELPER
--------------------------------*/

function broadcastToRoom(roomName, payload) {
  const roomInfo = rooms.get(roomName);
  if (!roomInfo) return;

  const msg = JSON.stringify(payload);

  for (const client of roomInfo.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}
