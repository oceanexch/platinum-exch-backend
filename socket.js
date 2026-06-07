
let io = null;

function setIO(ioInstance) {
  io = ioInstance;
}

function getIO() {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}

module.exports = { setIO, getIO };
