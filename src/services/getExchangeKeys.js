const axios = require("axios");

const authApi = axios.create({
  baseURL: process.env.AUTH_SERVICE_URL
});

async function getUserExchangeKeys(userId) {
  const resp = await authApi.post("/get-keys", { userId });
  return resp.data;
}

module.exports = getUserExchangeKeys;
