const mongoose = require("mongoose");

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true, // 🔥 CRITICAL
  },
  hostUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  hostSocketId: String,
  viewers: [
    {
      userId: mongoose.Schema.Types.ObjectId,
      socketId: String,
    },
  ],
  comments: [
    {
      username: String,
      text: String,
      timestamp: Number,
    },
  ],
});

module.exports = mongoose.model("Room", roomSchema);