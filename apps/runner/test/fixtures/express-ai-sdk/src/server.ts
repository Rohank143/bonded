import express from "express";
import { agentTools } from "./tools.js";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const tools = agentTools();
  res.json({ ok: true, tools: Object.keys(tools), body: req.body });
});

app.listen(3000);
