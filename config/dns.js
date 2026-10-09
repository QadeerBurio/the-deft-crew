// config/dns.js
// Same DNS setup as server.js ("DNS CONFIG"): resolve through public resolvers so the
// mongodb+srv lookup (_mongodb._tcp.<cluster>) works on machines whose local resolver
// refuses SRV queries. Call before connectDB() in standalone scripts.
const dns = require("dns");

const DNS_SERVERS = ["1.1.1.1", "8.8.8.8"]; // keep in sync with server.js

function useServerDns() {
  dns.setServers(DNS_SERVERS);
}

module.exports = { useServerDns, DNS_SERVERS };
