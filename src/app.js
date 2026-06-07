const express = require("express");
const path = require("path");

const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const connectDB = require("./config/database");
const authRoutes = require("./routes/AuthRoute");
const apiRoutes = require("./routes/ApiRoute");
const userRoutes = require("./routes/UserRoute");
const scriptRoutes = require("./routes/ScriptRoute");
const stockRoutes = require("./routes/StockRoute");
const settingRoutes = require("./routes/SettingRoute");
const ReportRoutes = require("./routes/ReportRoute");
const chatRoutes = require("./routes/ChatRoute");
const voiceRoutes = require("./routes/VoiceRoute");
const monitorRoutes = require("./routes/MonitorRoute");
const dailyHighLowRoutes = require("./routes/DailyHighLowRoute");
// const analyticsRoutes = require('./routes/analyticsRoutes');
const appVersionRoutes = require('./routes/appVersionRoutes');
// Initialize Express app
const app = express();

// Trust proxy to get real client IP from x-forwarded-for header
app.set('trust proxy', true);

// Set server timeout to handle long-running requests (like NSE API calls)
app.timeout = 90000; // 90 seconds

// ----- CORS: handle OPTIONS first and allow origins -----
const allowedHosts = ['172.236.176.175', '150.107.238.224', '192.168.0.160', 'localhost', '127.0.0.1'];
function isOriginAllowed(origin) {
  if (!origin || typeof origin !== 'string') return true;
  try {
    const u = new URL(origin);
    return allowedHosts.includes(u.hostname);
  } catch (e) {
    return false;
  }
}
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedHosts[0] ? `http://${allowedHosts[0]}` : '*');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}
// Handle OPTIONS immediately so preflight always gets CORS headers
app.use((req, res, next) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const corsOptions = {
  origin: (origin, callback) => {
    const allow = !origin || isOriginAllowed(origin);
    callback(null, allow ? (origin || `http://${allowedHosts[0]}`) : false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from the uploads directory with CORS enabled
app.use('/uploads', cors(corsOptions), express.static(path.join(__dirname, '../uploads')));


// Connect to the database
connectDB();

// Use API routes
app.use("/api/auth", authRoutes);
app.use("/api/data", apiRoutes);
app.use("/api/user", userRoutes);
app.use("/api/script", scriptRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/setting", settingRoutes);
app.use("/api/report", ReportRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/monitor", monitorRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/dailyhighlow", dailyHighLowRoutes);
// app.use('/api/analytics', analyticsRoutes);
app.use('/api/app-version', appVersionRoutes);


module.exports = app;
