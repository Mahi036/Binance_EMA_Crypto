// disable any proxy-from-env
process.env.HTTP_PROXY  = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy  = '';
process.env.https_proxy = '';
process.env.NO_PROXY    = '';
process.env.no_proxy    = 'localhost,127.0.0.1';

const axios = require('axios');
axios.defaults.proxy = false;

(async () => {
  try {
    const res = await axios.get('http://localhost:8090/api/v3/exchangeInfo');
    console.log("✅ proxy is up, symbols count =", res.data.symbols.length);
  } catch (err) {
    console.error("❌ proxy test failed:", err.response?.status, err.response?.data || err);
  }
})();
