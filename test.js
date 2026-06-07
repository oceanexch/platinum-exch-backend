const mongoose = require('mongoose');
const { getSummaryReport } = require('./src/controllers/StockController.js');

(async () => {
    await mongoose.connect('mongodb://localhost:27017/metro-backend-new', { useNewUrlParser: true, useUnifiedTopology: true });
    // Assuming some stub data and function for testing locally to bypass normal request flow
    console.log("To be integrated");
    mongoose.disconnect();
})();
