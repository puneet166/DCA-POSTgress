const axios = require("axios");

const authApi = axios.create({
  baseURL: process.env.AUTH_SERVICE_URL
});

async function checkSubscription(userId) {
  const resp = await authApi.post("/check-subscription", { userId });
  return resp.data.subscriptionActive;
}

module.exports = checkSubscription;
