const axios = require("axios");
const BASE_URL = process.env.API_END_POINT;

// Create an instance of axios with the base URL and optional config
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Function to make a GET request
exports.getData = async (endpoint) => {
  try {
    const response = await apiClient.get(endpoint);
    return response.data;
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error; // Or handle it more gracefully
  }
};
