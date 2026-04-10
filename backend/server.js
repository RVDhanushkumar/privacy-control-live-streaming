require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const Room = require("./models/Room");
const socketAuth = require("./middleware/socketAuth");

const app = express();
app.use(cors());
app.use(express.json());

const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("Mongo Error:", err));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 🔐 Secure socket with JWT
io.use(socketAuth);

io.on("connection", (socket) => {
  const userId = socket.user.id;
  console.log("Authenticated:", userId);

  // 🔥 CREATE ROOM
  socket.on("create-room", async (roomId) => {
    if (!roomId || typeof roomId !== "string") {
      socket.emit("invalid-room-id");
      return;
    }

    try {
      // ✅ FIX: Delete any stale room owned by this host (handles host page refresh)
      const staleRoom = await Room.findOne({ hostUserId: userId });
      if (staleRoom) {
        // Notify any lingering viewers in stale room
        io.to(staleRoom.roomId).emit("host-disconnected");
        await Room.deleteOne({ roomId: staleRoom.roomId });
        console.log(`Stale room ${staleRoom.roomId} deleted for user ${userId}`);
      }

      // ✅ FIX: Also check if the roomId is taken by a DIFFERENT host
      const roomIdTaken = await Room.findOne({ roomId });
      if (roomIdTaken) {
        socket.emit("room-already-exists");
        return;
      }

      await Room.create({
        roomId,
        hostUserId: userId,
        hostSocketId: socket.id,
        viewers: [],
        comments: []
      });

      socket.join(roomId);
      socket.emit("room-created", { roomId });
      console.log(`Room ${roomId} created by user ${userId}`);
    } catch (err) {
      console.error("Error creating room:", err);
      socket.emit("room-create-error");
    }
  });

  // 👥 JOIN ROOM
  socket.on("join-room", async (roomId) => {
    console.log("Joining roomId:", roomId);

    try {
      const room = await Room.findOne({ roomId });
      console.log("Room found:", room);

      if (!room) {
        socket.emit("room-not-found");
        return;
      }

      // ✅ FIX: Update stale socketId if viewer already exists, instead of skipping
      const existingViewer = room.viewers.find(v => v.userId.toString() === userId);
      if (existingViewer) {
        existingViewer.socketId = socket.id;
        console.log(`Updated socketId for existing viewer ${userId}`);
      } else {
        room.viewers.push({ userId, socketId: socket.id });
        console.log(`New viewer ${userId} added`);
      }

      await room.save();

      socket.join(roomId);

      // Send existing comments to the joining viewer
      socket.emit("existing-comments", room.comments);

      // ✅ FIX: Always emit viewer-joined so host always creates a fresh WebRTC offer
      io.to(room.hostSocketId).emit("viewer-joined", socket.id);
      io.to(roomId).emit("viewer-count", room.viewers.length);

      console.log(`User ${userId} joined room ${roomId}`);
    } catch (err) {
      console.error("Error joining room:", err);
      socket.emit("room-join-error");
    }
  });

  // 💬 COMMENTS
  socket.on("send-comment", async ({ roomId, username, text }) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return;

      const comment = {
        username,
        text,
        timestamp: Date.now()
      };

      room.comments.push(comment);

      // Keep only last 100 comments
      if (room.comments.length > 100) {
        room.comments.shift();
      }

      await room.save();
      io.to(roomId).emit("new-comment", comment);
    } catch (err) {
      console.error("Error sending comment:", err);
    }
  });

  // 🎥 HOST VIDEO STATE (ONLY HOST ALLOWED)
  socket.on("host-video-state", async ({ roomId, isPaused }) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return;

      // ✅ Security: only allow actual host to emit this
      if (room.hostUserId.toString() !== userId) return;

      room.viewers.forEach(viewer => {
        io.to(viewer.socketId).emit("host-video-paused", isPaused);
      });
    } catch (err) {
      console.error("Error updating video state:", err);
    }
  });

  // 🔁 SIGNAL RELAY
  socket.on("offer", ({ to, offer }) => {
    io.to(to).emit("offer", { from: socket.id, offer });
  });

  socket.on("answer", ({ to, answer }) => {
    io.to(to).emit("answer", { from: socket.id, answer });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  // ❌ DISCONNECT
  socket.on("disconnect", async () => {
    console.log("Disconnected:", socket.id);

    try {
      // ✅ FIX: Use hostSocketId (not hostUserId) to correctly identify host disconnect
      const hostRoom = await Room.findOne({ hostSocketId: socket.id });

      if (hostRoom) {
        // Notify all viewers the host has left
        io.to(hostRoom.roomId).emit("host-disconnected");
        await Room.deleteOne({ roomId: hostRoom.roomId });
        console.log(`Room ${hostRoom.roomId} deleted — host disconnected`);
        return;
      }

      // ✅ FIX: Find viewer room by socketId (not userId) — handles multi-session edge cases
      const room = await Room.findOne({ "viewers.socketId": socket.id });

      if (room) {
        room.viewers = room.viewers.filter(v => v.socketId !== socket.id);
        await room.save();

        io.to(room.hostSocketId).emit("viewer-left", socket.id);
        io.to(room.roomId).emit("viewer-count", room.viewers.length);
        console.log(`Viewer ${socket.id} removed from room ${room.roomId}`);
      }
    } catch (err) {
      console.error("Error during disconnect cleanup:", err);
    }
  });
});

server.listen(5000, () => {
  console.log("🚀 Secure Server running on port 5000");
});