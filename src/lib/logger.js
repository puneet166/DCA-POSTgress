const winston = require('winston');
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '../../.env')
});
function initLogger(){
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()]
  });
}

module.exports = { initLogger };
