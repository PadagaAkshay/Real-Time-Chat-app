const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chatapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.on('connected', () => {
  console.log('Connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

// Message Schema
const messageSchema = new mongoose.Schema({
  username: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  room: { type: String, default: 'general' }
});

const Message = mongoose.model('Message', messageSchema);

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Store active users
const activeUsers = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle user joining
  socket.on('join', async (username) => {
    try {
      socket.username = username;
      socket.room = 'general';
      
      // Join the room
      socket.join('general');
      
      // Update or create user in database
      await User.findOneAndUpdate(
        { username },
        { isOnline: true, lastSeen: new Date() },
        { upsert: true, new: true }
      );
      
      // Add to active users
      activeUsers.set(socket.id, { username, room: 'general' });
      
      // Get recent messages
      const recentMessages = await Message.find({ room: 'general' })
        .sort({ timestamp: -1 })
        .limit(50)
        .sort({ timestamp: 1 });
      
      // Send recent messages to the user
      socket.emit('previous messages', recentMessages);
      
      // Get online users
      const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
      
      // Broadcast user joined
      socket.to('general').emit('user joined', { username, onlineUsers });
      socket.emit('user joined', { username, onlineUsers });
      
      console.log(`${username} joined the chat`);
    } catch (error) {
      console.error('Error handling join:', error);
    }
  });

  // Handle new messages
  socket.on('chat message', async (data) => {
    try {
      const { message } = data;
      const username = socket.username;
      const room = socket.room || 'general';
      
      if (!username) {
        socket.emit('error', 'Please join with a username first');
        return;
      }
      
      // Save message to database
      const newMessage = new Message({
        username,
        message,
        room,
        timestamp: new Date()
      });
      
      await newMessage.save();
      
      // Broadcast message to all users in the room
      io.to(room).emit('chat message', {
        username,
        message,
        timestamp: newMessage.timestamp
      });
      
      console.log(`${username}: ${message}`);
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // Handle typing indicator
  socket.on('typing', (data) => {
    socket.to(socket.room || 'general').emit('typing', {
      username: socket.username,
      isTyping: data.isTyping
    });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    try {
      const userInfo = activeUsers.get(socket.id);
      if (userInfo) {
        const { username, room } = userInfo;
        
        // Update user status in database
        await User.findOneAndUpdate(
          { username },
          { isOnline: false, lastSeen: new Date() }
        );
        
        // Remove from active users
        activeUsers.delete(socket.id);
        
        // Get updated online users
        const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
        
        // Broadcast user left
        socket.to(room).emit('user left', { username, onlineUsers });
        
        console.log(`${username} left the chat`);
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/messages/:room?', async (req, res) => {
  try {
    const room = req.params.room || 'general';
    const messages = await Message.find({ room })
      .sort({ timestamp: -1 })
      .limit(100)
      .sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ lastSeen: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
