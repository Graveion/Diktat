const ws = new WebSocket("ws://localhost:9000");

ws.onopen = () => {
  console.log("Connected to daemon");
  ws.send(JSON.stringify({ type: "ping", message: "hello" }));
};

ws.onmessage = (event) => {
  console.log("Received:", event.data);
  ws.close();
  process.exit(0);
};

ws.onerror = (err) => {
  console.error("Connection failed - is the daemon running?");
  process.exit(1);
};
