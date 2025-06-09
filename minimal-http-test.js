// minimal-http-test.js
const http = require('http');
http.get('http://localhost:8090/api/v3/exchangeInfo', res => {
  console.log("Status:", res.statusCode);
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log("Length of response:", body.length));
}).on('error', console.error);
