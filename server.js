import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const PORT = process.env.PORT || 8080;

const RENDER_HOSTNAME = process.env.RENDER_EXTERNAL_URL
  ? new URL(process.env.RENDER_EXTERNAL_URL).hostname
  : null;

function getWsUrl(req) {
  // Render provides this in production
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/^http/, "ws");
  }

  // Local dev fallback
  const host = req.headers.host;
  return `ws://${host}`;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const { hostname } = new URL(origin);

    // Your custom domain(s)
    if (hostname.endsWith("incognitifier.com")) return true;

    // Your specific Render service only
    if (RENDER_HOSTNAME && hostname === RENDER_HOSTNAME) return true;

    // Local dev
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;

    return false;
  } catch {
    return false;
  }
}


// HTTP server (required by Render)
const server = http.createServer((req, res) => {
  if (req.url === "/_ws") {
    const wsUrl = getWsUrl(req);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ wsUrl }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// Attach WebSocket to HTTP server
const wss = new WebSocketServer({ server });

const rooms = new Map();
const MAX_MESSAGES_PER_ROOM = 100;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

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

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "list-rooms") {
      const publicRooms = [];
      for (const [roomName, info] of rooms.entries()) {
        if (!info.isPrivate) publicRooms.push(roomName);
      }
      ws.send(
        JSON.stringify({ type: "room-list", rooms: publicRooms.slice(0, 25) }),
      );
      return;
    }

    if (data.type === "create-room") {
      const { roomName, isPrivate } = data;
      if (!roomName) return;
      if (!rooms.has(roomName)) {
        rooms.set(roomName, {
          clients: new Set(),
          messages: [],
          isPrivate: !!isPrivate,
        });
      }
      return;
    }

    if (data.type === "join") {
      const { username, room } = data;
      if (!username || !room) return;

      ws.username = username;
      ws.room = room;

      if (!rooms.has(room)) {
        rooms.set(room, { clients: new Set(), messages: [], isPrivate: false });
      }

      const roomInfo = rooms.get(room);
      roomInfo.clients.add(ws);

      ws.send(JSON.stringify({ type: "your-id", userId: ws.userId }));
      roomInfo.messages.forEach((msg) => ws.send(JSON.stringify(msg)));

      broadcastToRoom(room, {
        type: "system",
        message: `${username} joined ${room}`,
      });
      return;
    }

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

      broadcastToRoom(ws.room, payload);
    }
  });

  ws.on("close", () => {
    if (!ws.username || !ws.room) return;

    const roomInfo = rooms.get(ws.room);
    if (!roomInfo) return;

    roomInfo.clients.delete(ws);

    broadcastToRoom(ws.room, {
      type: "system",
      message: `${ws.username} left the chat`,
    });

    if (roomInfo.clients.size === 0) {
      rooms.delete(ws.room);
    }
  });
});

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

// // server.js
// import { WebSocketServer } from "ws";
// import { randomUUID } from "crypto";

// const wss = new WebSocketServer({ port: 8080 });
// const rooms = new Map(); // roomName -> { clients: Set<ws>, messages: Array, isPrivate: boolean }

// const MAX_MESSAGES_PER_ROOM = 100; // keep last 100 messages per room

// console.log("WebSocket server running on ws://localhost:8080");

// wss.on("connection", (ws) => {
//   ws.username = null;
//   ws.room = null;
//   ws.userId = randomUUID(); // unique per connection

//   console.log("Client connected:", ws.userId);

//   ws.on("message", (raw) => {
//     let data;
//     try {
//       data = JSON.parse(raw.toString());
//     } catch {
//       return;
//     }

//     // LIST PUBLIC ROOMS
//     if (data.type === "list-rooms") {
//       const publicRooms = [];
//       for (const [roomName, info] of rooms.entries()) {
//         if (!info.isPrivate) publicRooms.push(roomName);
//       }
//       ws.send(JSON.stringify({ type: "room-list", rooms: publicRooms.slice(0, 25) }));
//       return;
//     }

//     // CREATE ROOM
//     if (data.type === "create-room") {
//       const { roomName, isPrivate } = data;
//       if (!roomName) return;
//       if (!rooms.has(roomName)) {
//         rooms.set(roomName, { clients: new Set(), messages: [], isPrivate: !!isPrivate });
//         console.log(`Room created: ${roomName} (private=${!!isPrivate})`);
//       }
//       return;
//     }

//     // JOIN ROOM
//     if (data.type === "join") {
//       const { username, room } = data;
//       if (!username || !room) return;

//       ws.username = username;
//       ws.room = room;

//       if (!rooms.has(room)) {
//         rooms.set(room, { clients: new Set(), messages: [], isPrivate: false });
//       }

//       const roomInfo = rooms.get(room);
//       roomInfo.clients.add(ws);

//       // Send own userId for front-end differentiation
//       ws.send(JSON.stringify({ type: "your-id", userId: ws.userId }));

//       // Send last messages to the new client
//       roomInfo.messages.forEach((msg) => ws.send(JSON.stringify(msg)));

//       // Broadcast system message
//       broadcastToRoom(room, {
//         type: "system",
//         message: `${username} joined ${room}`,
//       });

//       console.log(`${username} joined room ${room}`);
//       return;
//     }

//     // CHAT MESSAGE
//     if (data.type === "message") {
//       if (!ws.username || !ws.room) return;

//       const roomInfo = rooms.get(ws.room);
//       if (!roomInfo) return;

//       const payload = {
//         type: "message",
//         username: ws.username,
//         userId: ws.userId,
//         message: data.message,
//       };

//       // Add to room messages
//       roomInfo.messages.push(payload);

//       // Drop oldest messages if exceeding limit
//       if (roomInfo.messages.length > MAX_MESSAGES_PER_ROOM) {
//         roomInfo.messages.shift();
//       }

//       broadcastToRoom(ws.room, payload);
//       return;
//     }
//   });

//   ws.on("close", () => {
//     if (!ws.username || !ws.room) return;

//     const roomInfo = rooms.get(ws.room);
//     if (!roomInfo) return;

//     roomInfo.clients.delete(ws);

//     broadcastToRoom(ws.room, {
//       type: "system",
//       message: `${ws.username} left the chat`,
//     });

//     // Clean up empty rooms
//     if (roomInfo.clients.size === 0) {
//       rooms.delete(ws.room);
//       console.log(`Room ${ws.room} deleted`);
//     }

//     console.log(`${ws.username} disconnected`);
//   });
// });

// // Helper: broadcast to all clients in a room
// function broadcastToRoom(roomName, payload) {
//   const roomInfo = rooms.get(roomName);
//   if (!roomInfo) return;

//   const msg = JSON.stringify(payload);

//   for (const client of roomInfo.clients) {
//     if (client.readyState === client.OPEN) {
//       client.send(msg);
//     }
//   }
// }
