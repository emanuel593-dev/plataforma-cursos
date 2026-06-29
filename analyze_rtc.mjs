import { readFileSync } from 'fs';
const j = JSON.parse(readFileSync('webrtc_internals_dump', 'utf8'));
const stats = j.PeerConnections['120-31'].stats;
const keys = Object.keys(stats);

// Find nominated candidate pair
const nomKey = keys.find(k => k.endsWith('-nominated') && JSON.parse(stats[k].values).includes(true));
const pairId = nomKey ? nomKey.replace('-nominated','') : null;
console.log('\n=== ICE CANDIDATE PAIR ===');
console.log('Nominated pair ID:', pairId);
if (pairId) {
  ['state','bytesSent','bytesReceived','currentRoundTripTime','packetsSent','packetsReceived'].forEach(f => {
    const v = stats[pairId+'-'+f];
    if (v) { const arr = JSON.parse(v.values); console.log(f+':', arr[arr.length-1]); }
  });
  const locId = JSON.parse(stats[pairId+'-localCandidateId'].values).pop();
  const remId = JSON.parse(stats[pairId+'-remoteCandidateId'].values).pop();
  console.log('localCandidateId:', locId);
  console.log('remoteCandidateId:', remId);
  // Try to find local/remote candidate info
  const locPrefix = 'I' + locId.replace(/^[A-Z]/,'');
  const remPrefix = 'I' + remId.replace(/^[A-Z]/,'');
  ['candidateType','address','port','protocol','relayProtocol'].forEach(f => {
    const lk = keys.find(k => k.startsWith(locId) && k.endsWith('-'+f));
    const rk = keys.find(k => k.startsWith(remId) && k.endsWith('-'+f));
    if (lk) { const arr = JSON.parse(stats[lk].values); console.log('local.'+f+':', arr[arr.length-1]); }
    if (rk) { const arr = JSON.parse(stats[rk].values); console.log('remote.'+f+':', arr[arr.length-1]); }
  });
}

// updateLog: show all events with type
console.log('\n=== UPDATE LOG EVENTS ===');
const log = j.PeerConnections['120-31'].updateLog;
log.forEach(e => {
  if (e.type !== 'getStats') {
    const preview = e.value ? String(e.value).substring(0,120).replace(/\n/g,' ') : '';
    console.log(`[${e.time}] ${e.type}: ${preview}`);
  }
});

// SDP from setLocalDescription
console.log('\n=== setLocalDescription SDP ===');
const sld = log.find(e => e.type === 'setLocalDescription');
if (sld) console.log(sld.value);

console.log('\n=== setRemoteDescription SDP ===');
const srd = log.find(e => e.type === 'setRemoteDescription');
if (srd) console.log(srd.value);

// Last outbound audio bytesSent
const obKey = keys.find(k => k === 'OT01A115581097-bytesSent');
if (obKey) {
  const arr = JSON.parse(stats[obKey].values);
  console.log('\n=== OUTBOUND AUDIO bytesSent LAST 5 ===', arr.slice(-5));
}
const ibKey = keys.find(k => k === 'IT01A3712028463-audioLevel');
if (ibKey) {
  const arr = JSON.parse(stats[ibKey].values);
  console.log('=== INBOUND AUDIO audioLevel LAST 5 ===', arr.slice(-5));
}
