import fetch from 'node-fetch';
import crypto from 'crypto';

async function testApi() {
  const orgId = "test_org_123";
  const secretPart = "testkey123";
  const rawKey = `vox_${orgId}_${secretPart}`;

  const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = `vox_${orgId}_${secretPart.substring(0, 4)}`;

  // 1. Register a mock API key via the internal endpoint
  const registerRes = await fetch('http://localhost:3000/internal/apikeys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'test_key_id',
      orgId,
      name: 'Test Key',
      keyPrefix,
      hashedKey,
      createdAt: new Date().toISOString(),
    }),
  });
  if (!registerRes.ok) {
    throw new Error(`Failed to register key: ${await registerRes.text()}`);
  }

  console.log('Created mock API key:', rawKey);

  // 2. Test the API endpoints
  const baseUrl = 'http://localhost:3000/api/v1';
  
  // Test 1: Create Room
  console.log("\n--- Testing /rooms/create ---");
  const createRes = await fetch(`${baseUrl}/rooms/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': rawKey
    },
    body: JSON.stringify({
      externalId: "candidate_001",
      candidateName: "Test Candidate"
    })
  });
  const createData = await createRes.json();
  console.log("Status:", createRes.status);
  console.log("Response:", createData);

  // Test 2: List Sessions
  console.log("\n--- Testing /sessions ---");
  const listRes = await fetch(`${baseUrl}/sessions`, {
    method: 'GET',
    headers: {
      'x-api-key': rawKey
    }
  });
  const listData = await listRes.json();
  console.log("Status:", listRes.status);
  console.log("Response:", listData);
  
  // Cleanup
  await fetch('http://localhost:3000/internal/apikeys/test_key_id', { method: 'DELETE' });
  console.log('\nCleanup complete.');
}

testApi().catch(console.error);
