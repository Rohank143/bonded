import { Hono } from "hono";

const app = new Hono();
app.get("/", (c) => c.text("my agent"));

export default app;
