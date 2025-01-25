const redis = require('redis');
const { redisConfig } = require('./redisConfig');

const client = redis.createClient(redisConfig);

client.connect().then(() => {
  console.log('Connected to Redis');
  client.sendCommand(['CONFIG', 'SET', 'SAVE', '120 1']).then((result) => {
    console.log('SAVE Snapshot interval set to 2 mins:', result);
  }).catch((error) => {
    console.error('Error setting snapshot interval:', error);
  });
  client.sendCommand(['BGSAVE']).then((result) => {
    console.log('BGSAVE Snapshot Status:', result);
  }).catch((error) => {
    console.error('Error setting snapshot interval:', error);
  });
}).catch(err => {
  console.error('Error connecting to Redis:', err);
});

module.exports = client;
