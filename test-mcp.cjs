const http = require('https');

// Configuration for your new Hugging Face Space
const TARGET_HOST = 'osodiq325-routerisk-asp.hf.space';
const BASE_PATH = '/mcp';

console.log("1. Opening live SSE stream session...");
const reqGet = http.get(`https://${TARGET_HOST}${BASE_PATH}`, {
  headers: { 'Accept': 'text/event-stream' }
}, (res) => {
  res.on('data', (chunk) => {
    const dataStr = chunk.toString();
    if (dataStr.trim()) {
      console.log("\n[SSE Stream Received Event]:\n", dataStr);
      
      // Catch the true session ID to trigger the execution call
      if (dataStr.includes('sessionId=')) {
        const matchedId = dataStr.split('sessionId=')[1].trim();
        triggerPost(matchedId);
      } 
      // Catch the final tool result returning from your engine over the stream
      else if (dataStr.includes('"result"') || dataStr.includes('content')) {
        console.log("\n=================================================");
        console.log("====== FINAL RISK ENGINE ANALYSIS RECEIVED ======");
        console.log("=================================================");
        console.log(dataStr);
        console.log("=================================================");
        process.exit(0);
      }
    }
  });
});

reqGet.on('error', (e) => console.error("GET Stream Error:", e));

function triggerPost(realSessionId) {
  console.log(`\n2. Session active. Triggering tool call on active ID: ${realSessionId}`);
  
  const postData = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    id: "2",
    params: {
      name: "check_route_safety",
      arguments: {
        chainId: "1",
        fromTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        toTokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        realAmount: "100000000"
      }
    }
  });

  const reqPost = http.request({
    hostname: TARGET_HOST,
    path: `${BASE_PATH}/messages?sessionId=${realSessionId}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (resPost) => {
    let body = '';
    resPost.on('data', chunk => body += chunk);
    resPost.on('end', () => {
      console.log("\n3. Direct POST ingestion channel response received:");
      try {
        console.log(JSON.stringify(JSON.parse(body), null, 2));
      } catch {
        console.log(body);
      }
      console.log("\nAwaiting asynchronous execution logs back from the stream...");
    });
  });

  reqPost.on('error', (e) => console.error("POST Error:", e));
  reqPost.write(postData);
  reqPost.end();
}