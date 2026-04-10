const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  faceDescriptor: {
    type: [Number],   // 128-d vector
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);