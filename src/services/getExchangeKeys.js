const axios = require("axios");

const authApi = axios.create({
  baseURL: process.env.AUTH_SERVICE_URL
});

async function getUserExchangeKeys(userId) {
  const resp = await authApi.post("/get-keys", { userId });
  console.log("resp=>",resp)
  return resp.data;
}

module.exports = getUserExchangeKeys;
