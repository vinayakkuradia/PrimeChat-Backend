import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/_ws") {
    const protocol = location.protocol === "https:" ? "wss" : "ws"
    const wsUrl = `${protocol}://${req.headers.host}`;

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
   DATA
--------------------------------*/

const waitingUsers = new Set();

/* -----------------------------
   WEBSOCKET
--------------------------------*/

wss.on("connection", (ws) => {
  ws.userId = randomUUID();
  ws.partner = null;
  ws.username = null;

  ws.send(
    JSON.stringify({
      type: "your-id",
      userId: ws.userId,
    }),
  );

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* =============================
       JOIN STRANGER CHAT
    ==============================*/

    if (data.type === "stranger-join") {
      if (ws.partner) return;

      ws.username = data.username;

      const partner = waitingUsers.values().next().value;

      if (partner && partner !== ws) {
        waitingUsers.delete(partner);

        ws.partner = partner;
        partner.partner = ws;

        ws.send(JSON.stringify({ type: "stranger-matched" }));
        partner.send(JSON.stringify({ type: "stranger-matched" }));

        ws.send(
          JSON.stringify({
            type: "system",
            message: `${partner.username} connected`,
          }),
        );

        partner.send(
          JSON.stringify({
            type: "system",
            message: `${ws.username} connected`,
          }),
        );

        return;
      }

      waitingUsers.add(ws);

      ws.send(
        JSON.stringify({
          type: "stranger-waiting",
        }),
      );

      return;
    }

    /* =============================
       CHAT MESSAGE
    ==============================*/

    if (data.type === "message") {
      if (!ws.partner) return;

      const payload = {
        type: "message",
        username: ws.username,
        userId: ws.userId,
        message: data.message,
      };

      const msg = JSON.stringify(payload);

      // send to sender
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }

      // send to partner
      if (ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(msg);
      }
    }

    /* =============================
       NEXT STRANGER
    ==============================*/

    if (data.type === "next") {
      disconnectPartner(ws);

      // Remove self from waiting pool if accidentally there
      waitingUsers.delete(ws);

      // We don't auto-add to waiting here anymore because the client will handle that after sending the "next" message. This gives the client more control over when to rejoin the queue.
    }

    /* =============================
       TYPING INDICATOR
    ==============================*/
    if (data.type === "typing") {
      if (!ws.partner) return;

      if (ws.partner.readyState === WebSocket.OPEN) {
        ws.partner.send(
          JSON.stringify({
            type: "typing",
            username: ws.username,
            userId: ws.userId,
          }),
        );
      }

      return;
    }
  });

  /* -----------------------------
     DISCONNECT
  --------------------------------*/

  ws.on("close", () => {
    waitingUsers.delete(ws);
    disconnectPartner(ws);
  });
});

/* -----------------------------
   DISCONNECT PARTNER
--------------------------------*/

function disconnectPartner(ws) {
  const partner = ws.partner;

  if (!partner) return;

  ws.partner = null;
  partner.partner = null;

  if (partner.readyState === partner.OPEN) {
    partner.send(
      JSON.stringify({
        type: "partner-left",
      }),
    );

    // Directly connecting the partner to a new stranger without going through the waiting state
    // waitingUsers.add(partner);

    // partner.send(
    //   JSON.stringify({
    //     type: "stranger-waiting",
    //   }),
    // );
  }
}
