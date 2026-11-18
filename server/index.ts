import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { AgentBusyError, resetSession, runAgent } from "./agent";

const PORT = Number(process.env.PORT ?? 3001);
const BUILD_DIR = path.join(__dirname, "..", "build");
const app = express();
// Hosts like Render sit behind one reverse proxy; trust it so req.ip is the real client IP.
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute and try again." },
}));

function readSessionId(body: any): string | null {
    const id = body?.sessionId;
    return typeof id === "string" && /^[\w-]{8,64}$/.test(id) ? id : null;
}

app.post("/api/chat", async (req, res) => {
    const sessionId = readSessionId(req.body);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!sessionId) return res.status(400).json({ error: "Invalid or missing sessionId." });
    if (!message) return res.status(400).json({ error: "Message must be a non-empty string." });
    if (message.length > 2000) return res.status(400).json({ error: "Message is too long (max 2000 characters)." });

    try {
        const reply = await runAgent(sessionId, message);
        res.json({ reply });
    } catch (err) {
        console.error(err);
        if (err instanceof AgentBusyError) {
            res.status(409).json({ error: err.message });
        } else if (err instanceof Anthropic.AuthenticationError) {
            res.status(500).json({ error: "Server is missing a valid Anthropic API key." });
        } else if (err instanceof Anthropic.RateLimitError) {
            res.status(429).json({ error: "Too many requests right now. Please try again in a moment." });
        } else if (err instanceof Anthropic.APIError) {
            res.status(502).json({ error: "The AI service is unavailable. Please try again." });
        } else {
            res.status(500).json({ error: "Something went wrong. Please try again." });
        }
    }
});

app.post("/api/reset", (req, res) => {
    const sessionId = readSessionId(req.body);
    if (sessionId) resetSession(sessionId);
    res.json({ ok: true });
});

// Serve the production React build; any non-API route falls back to index.html.
app.use(express.static(BUILD_DIR));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(BUILD_DIR, "index.html")));

app.listen(PORT, () => {
    console.log(`Weather agent server listening on http://localhost:${PORT}`);
});
