import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import rateLimit from "express-rate-limit";

// ── In-memory stores (replace with Supabase on production) ───────────────────
// roomId -> room metadata
const roomsStore = new Map<string, {
  roomId: string;
  orgId: string;
  externalId: string;
  candidateName: string;
  status: string;
  createdAt: Date;
}>();

// hashedKey -> key metadata
const apiKeysStore = new Map<string, {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  hashedKey: string;
  createdAt: Date;
  lastUsedAt?: Date;
}>();

// sessionId -> session data
const sessionsStore = new Map<string, {
  id: string;
  userId: string;
  orgId: string | null;
  externalId?: string;
  mode: string;
  duration?: number;
  summary?: string;
  transcriptions?: unknown[];
  timestamp: Date;
}>();

// ── Internal sync helpers (called by the frontend admin panel) ────────────────
// These endpoints are NOT rate-limited and are only for same-origin requests.

/** Reject requests from non-loopback addresses to protect internal routes. */
function localOnlyMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const addr = req.socket.remoteAddress || '';
  const isLocalhost = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!isLocalhost) return res.status(403).json({ error: 'Forbidden' });
  next();
}

function registerInternalRoutes(app: express.Application) {
  app.use('/internal', localOnlyMiddleware);

  // Register / update an API key (called from Admin view after creating a key)
  app.post("/internal/apikeys", express.json(), (req, res) => {
    const key = req.body;
    if (!key?.hashedKey || !key?.orgId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    apiKeysStore.set(key.hashedKey, {
      ...key,
      createdAt: key.createdAt ? new Date(key.createdAt) : new Date(),
    });
    res.json({ success: true });
  });

  // Delete an API key by id
  app.delete("/internal/apikeys/:id", (req, res) => {
    const { id } = req.params;
    for (const [hashedKey, keyData] of apiKeysStore.entries()) {
      if (keyData.id === id) {
        apiKeysStore.delete(hashedKey);
        return res.json({ success: true });
      }
    }
    res.status(404).json({ error: "Key not found" });
  });

  // Register a session (called by the frontend after generating a summary)
  app.post("/internal/sessions", express.json(), (req, res) => {
    const session = req.body;
    if (!session?.id || !session?.userId) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    sessionsStore.set(session.id, {
      ...session,
      timestamp: session.timestamp ? new Date(session.timestamp) : new Date(),
    });
    res.json({ success: true });
  });

  // Delete a session
  app.delete("/internal/sessions/:id", (req, res) => {
    const { id } = req.params;
    if (sessionsStore.has(id)) {
      sessionsStore.delete(id);
      return res.json({ success: true });
    }
    res.status(404).json({ error: "Session not found" });
  });
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // CORS
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : [process.env.APP_URL, "http://localhost:3000"].filter(Boolean);

  app.use(
    "/api",
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-api-key"],
    })
  );

  // Rate limiting
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/v1", apiLimiter);

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
    },
  });
  const PORT = 3000;

  // ── API Key Validation Middleware ────────────────────────────────────────────
  const validateApiKey = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const apiKey = req.headers["x-api-key"] as string;
    if (!apiKey) return res.status(401).json({ error: "API key is required" });

    try {
      const parts = apiKey.split("_");
      if (parts.length < 3 || parts[0] !== "vox") {
        return res.status(401).json({ error: "Invalid API key format" });
      }

      const hashedKey = crypto.createHash("sha256").update(apiKey).digest("hex");
      const keyData = apiKeysStore.get(hashedKey);

      if (!keyData) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      (req as any).orgId = keyData.orgId;
      keyData.lastUsedAt = new Date();

      next();
    } catch (error: any) {
      console.error("API key validation error:", error);
      res.status(500).json({ error: "Internal server error during API key validation" });
    }
  };

  // ── Internal routes (no auth, localhost-only by convention) ─────────────────
  registerInternalRoutes(app);

  // ── WebRTC Signaling ─────────────────────────────────────────────────────────
  const rooms = new Map<string, string>(); // roomId -> hostUserId

  io.on("connection", (socket) => {
    socket.on("join-room", (roomId, userId, userName) => {
      socket.join(roomId);
      socket.join(userId);

      if (!rooms.has(roomId)) {
        rooms.set(roomId, userId);
        socket.emit("is-host", true);
      } else {
        socket.emit("is-host", false);
      }

      socket.to(roomId).emit("user-connected", userId, userName);

      socket.on("offer", (payload) => io.to(payload.target).emit("offer", payload));
      socket.on("answer", (payload) => io.to(payload.target).emit("answer", payload));
      socket.on("ice-candidate", (incoming) =>
        io.to(incoming.target).emit("ice-candidate", incoming.candidate, incoming.userId)
      );
      socket.on("peer-state-change", (payload) =>
        socket.to(roomId).emit("peer-state-change", payload)
      );

      socket.on("mute-participant", (targetUserId) => {
        if (rooms.get(roomId) === userId) {
          io.to(targetUserId).emit("mute-remote");
        }
      });

      socket.on("kick-participant", (targetUserId) => {
        if (rooms.get(roomId) === userId) {
          io.to(targetUserId).emit("kicked");
        }
      });

      socket.on("disconnect", () => {
        socket.to(roomId).emit("user-disconnected", userId);
        if (rooms.get(roomId) === userId) {
          rooms.delete(roomId);
        }
      });
    });
  });

  // ── Public Routes ─────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Create a room (ATS integration)
  app.post("/api/v1/rooms/create", validateApiKey, async (req, res) => {
    try {
      const { externalId, candidateName } = req.body;
      const orgId = (req as any).orgId;

      if (!externalId || typeof externalId !== "string" || externalId.length > 128) {
        return res.status(400).json({ error: "Invalid 'externalId' (must be a string up to 128 characters)" });
      }
      if (candidateName && (typeof candidateName !== "string" || candidateName.length > 100)) {
        return res.status(400).json({ error: "Invalid 'candidateName' (must be a string up to 100 characters)" });
      }

      const roomId = crypto.randomUUID();
      roomsStore.set(roomId, {
        roomId,
        orgId,
        externalId,
        candidateName: candidateName || "Unknown",
        status: "created",
        createdAt: new Date(),
      });

      res.status(201).json({
        roomId,
        orgId,
        externalId,
        url: `${req.protocol}://${req.get("host")}/room/${roomId}?externalId=${encodeURIComponent(externalId)}&candidate=${encodeURIComponent(candidateName || "")}`,
      });
    } catch (error) {
      console.error("Error creating room:", error);
      res.status(500).json({ error: "Failed to create room" });
    }
  });

  // List sessions for an org
  app.get("/api/v1/sessions", validateApiKey, async (req, res) => {
    try {
      const orgId = (req as any).orgId;
      const { externalId, limit = 50 } = req.query;

      let sessions = Array.from(sessionsStore.values()).filter(
        (s) => s.orgId === orgId
      );

      if (externalId) {
        sessions = sessions.filter((s) => s.externalId === String(externalId));
      }

      sessions.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      const limitedSessions = sessions.slice(0, Number(limit)).map((s) => ({
        id: s.id,
        externalId: s.externalId,
        duration: s.duration,
        timestamp: s.timestamp instanceof Date ? s.timestamp.toISOString() : s.timestamp,
        mode: s.mode,
      }));

      res.json({ sessions: limitedSessions });
    } catch (error) {
      console.error("Error fetching sessions:", error);
      res.status(500).json({ error: "Failed to fetch sessions" });
    }
  });

  // Get session insights
  app.get("/api/v1/sessions/:sessionId/insights", validateApiKey, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const orgId = (req as any).orgId;
      const { includeTranscriptions } = req.query;

      const sessionData = sessionsStore.get(sessionId);

      if (!sessionData) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (sessionData.orgId !== orgId) {
        return res.status(403).json({ error: "Unauthorized access to session" });
      }

      const response: any = {
        id: sessionData.id,
        externalId: sessionData.externalId,
        summary: sessionData.summary,
        duration: sessionData.duration,
        timestamp: sessionData.timestamp instanceof Date
          ? sessionData.timestamp.toISOString()
          : sessionData.timestamp,
        mode: sessionData.mode,
      };

      if (includeTranscriptions === "true") {
        response.transcriptions = sessionData.transcriptions || [];
      }

      res.json(response);
    } catch (error) {
      console.error("Error fetching session insights:", error);
      res.status(500).json({ error: "Failed to fetch session insights" });
    }
  });

  // Delete a session
  app.delete("/api/v1/sessions/:sessionId", validateApiKey, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const orgId = (req as any).orgId;

      const sessionData = sessionsStore.get(sessionId);

      if (!sessionData) {
        return res.status(404).json({ error: "Session not found" });
      }
      if (sessionData.orgId !== orgId) {
        return res.status(403).json({ error: "Unauthorized access to session" });
      }

      sessionsStore.delete(sessionId);
      res.json({ success: true, message: "Session deleted successfully" });
    } catch (error) {
      console.error("Error deleting session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  // ── Vite / Static ─────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
