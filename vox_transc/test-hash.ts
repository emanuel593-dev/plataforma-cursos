import crypto from 'crypto';

async function test() {
  const rawKey = 'vox_1234567890abcdef';
  const msgBuffer = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashedKey = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  console.log('Hashed Key (Frontend):', hashedKey);
  
  const backendHashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
  console.log('Hashed Key (Backend):', backendHashedKey);
  
  console.log('Match:', hashedKey === backendHashedKey);
}

test();
