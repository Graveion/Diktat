const PORT = 9000;

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Diktat daemon running", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("Client connected");
      ws.send(JSON.stringify({ type: "connected", message: "Diktat daemon ready" }));
    },
    message(ws, data) {
      console.log("Received:", data);
      ws.send(JSON.stringify({ type: "echo", message: data }));
    },
    close() {
      console.log("Client disconnected");
    },
  },
});

console.log(`Diktat daemon listening on ws://localhost:${PORT}`);
