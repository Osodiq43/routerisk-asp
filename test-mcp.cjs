const https = require('https');
const { execSync } = require('child_process');

const TARGET_HOST = 'osodiq325-routerisk-asp.hf.space';
const BASE_PATH = '/mcp';

function getChallenge() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: TARGET_HOST, path: BASE_PATH, method: 'GET' },
      (res) => {
        if (res.statusCode !== 402) {
          reject(new Error(`Expected 402, got ${res.statusCode}`));
          return;
        }
        const challenge = res.headers['payment-required'];
        res.resume();
        resolve(challenge);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function signChallenge(base64Payload) {
  console.log('2. Signing challenge via onchainos CLI (real wallet signature)...');
  let output;
  try {
    output = execSync(`onchainos payment pay --payload "${base64Payload}"`, {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error('CLI signing call failed or timed out:', e.message);
    if (e.stdout) console.error('stdout was:', e.stdout);
    if (e.stderr) console.error('stderr was:', e.stderr);
    throw e;
  }
  console.log('2b. CLI returned, parsing signature...');
  const parsed = JSON.parse(output);
  if (!parsed.ok) throw new Error('CLI signing failed: ' + output);
  console.log('2c. Signature obtained for wallet:', parsed.data.wallet);
  
  const rawHeader = parsed.data.authorization_header || "";
  const tokenOnly = rawHeader.replace(/^(exact|bearer)\s+/i, "");
  return `Exact ${tokenOnly}`;
}

function openPaidSession(signedHeader) {
  return new Promise((resolve, reject) => {
    console.log('3. Sending paid request, waiting for response headers...');
    
    // Cover all potential header targets used by different SDK variations
    const headers = { 
      'Authorization': signedHeader,
      'authorization': signedHeader,
      'payment-signature': signedHeader,
      'Accept': 'text/event-stream' 
    };

    const req = https.request(
      {
        hostname: TARGET_HOST,
        path: BASE_PATH,
        method: 'GET',
        headers: headers,
      },
      (res) => {
        console.log(`3b. Response received: HTTP ${res.statusCode}`);
        if (res.statusCode !== 200) {
          console.log('\n--- DEBUG: 402 RESPONSE HEADERS ---');
          console.log(JSON.stringify(res.headers, null, 2));
          console.log('------------------------------------\n');
          
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => reject(new Error(`Expected 200 after payment, got ${res.statusCode}: ${errBody}`)));
          return;
        }
        console.log('4. Payment accepted -- SSE session opened, waiting for endpoint event...\n');
        res.on('data', (chunk) => {
          const dataStr = chunk.toString();
          if (!dataStr.trim()) return;
          console.log('[raw chunk]', dataStr);

          if (dataStr.includes('sessionId=')) {
            const sessionId = dataStr.split('sessionId=')[1].trim();
            console.log(`5. Live session: ${sessionId}`);
            callTool(sessionId);
          } else if (dataStr.includes('"result"') || dataStr.includes('"aiSummary"')) {
            console.log('\n=== ROUTE SAFETY ANALYSIS (real, paid, end-to-end) ===\n');
            console.log(dataStr);
            resolve();
            process.exit(0);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function callTool(sessionId) {
  const postData = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    id: '1',
    params: {
      name: 'check_route_safety',
      arguments: {
        chainId: '1',
        fromTokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        toTokenAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        realAmount: '20000000000000000000',
      },
    },
  });

  const req = https.request(
    {
      hostname: TARGET_HOST,
      path: `${BASE_PATH}/messages?sessionId=${sessionId}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    },
    (res) => { res.resume(); }
  );
  req.write(postData);
  req.end();
}

async function main() {
  console.log('1. Hitting RouteRisk with no payment -- expecting 402...');
  const challenge = await getChallenge();
  const signedHeader = signChallenge(challenge);
  await openPaidSession(signedHeader);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});