import http from "node:http";
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const frames = [
    { delta: { reasoning_content: "Let me think: " } },
    { delta: { content: "The answer is **4**." } },
  ];
  for (const f of frames) {
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: f, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
srv.listen(9778, () => console.log("SSE up on 9778"));
setTimeout(() => process.exit(0), 30000);
