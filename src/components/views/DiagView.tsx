// Diagnostic page for WebRTC connectivity validation.
//
// Goals:
//   - Show resolved ICE servers (and confirm TURN credentials reached the client).
//   - Run a probe RTCPeerConnection to gather candidates of every type
//     (host / srflx / relay) and surface them with RTT.
//   - Run a second probe in `iceTransportPolicy: 'relay'` mode to validate
//     that TURN is actually working (this is Sprint 1.2).
//
// Restricted to `coordenacao` via ProtectedRoute in App.tsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Play, AlertCircle, CheckCircle2, Globe, Shield } from 'lucide-react';
import Button from '../ui/Button';
import { loadIceServers } from '../../hooks/useWebRTC';

interface CandidateRow {
  id: string;
  type: string;       // host | srflx | prflx | relay | unknown
  protocol?: string;
  address?: string;
  port?: number;
  relatedAddress?: string;
  raw: string;
}

interface ProbeResult {
  mode: 'all' | 'relay-only';
  startedAt: number;
  finishedAt?: number;
  iceGatheringDurationMs?: number;
  candidates: CandidateRow[];
  error?: string;
  // Whether at least one relay candidate was gathered.
  hasRelay: boolean;
}

const GATHER_TIMEOUT_MS = 8000;

/** Parse a candidate string `candidate:foundation comp prot pri ip port typ host …` */
function parseCandidate(raw: string): Partial<CandidateRow> {
  // Example:
  // candidate:842163049 1 udp 1677729535 80.12.34.56 50091 typ srflx raddr 192.168.0.10 rport 50091
  const parts = raw.replace(/^candidate:/, '').split(' ');
  const type = parts[parts.indexOf('typ') + 1] ?? 'unknown';
  const protocol = parts[2];
  const address = parts[4];
  const port = Number(parts[5]);
  const raddrIdx = parts.indexOf('raddr');
  const relatedAddress = raddrIdx > -1 ? parts[raddrIdx + 1] : undefined;
  return { type, protocol, address, port: Number.isFinite(port) ? port : undefined, relatedAddress };
}

async function runIceProbe(
  iceServers: RTCIceServer[],
  mode: 'all' | 'relay-only',
): Promise<ProbeResult> {
  const startedAt = performance.now();
  const result: ProbeResult = { mode, startedAt, candidates: [], hasRelay: false };
  const config: RTCConfiguration = {
    iceServers,
    iceCandidatePoolSize: 0,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: mode === 'relay-only' ? 'relay' : 'all',
  };

  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection(config);
    // Add a data channel so the offer triggers ICE gathering.
    pc.createDataChannel('probe');

    const seen = new Set<string>();
    const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
      const cand = ev.candidate;
      if (!cand || !cand.candidate) return;
      if (seen.has(cand.candidate)) return;
      seen.add(cand.candidate);
      const parsed = parseCandidate(cand.candidate);
      const row: CandidateRow = {
        id: `${cand.candidate}-${seen.size}`,
        type: parsed.type ?? 'unknown',
        protocol: parsed.protocol,
        address: parsed.address,
        port: parsed.port,
        relatedAddress: parsed.relatedAddress,
        raw: cand.candidate,
      };
      result.candidates.push(row);
      if (row.type === 'relay') result.hasRelay = true;
    };
    pc.addEventListener('icecandidate', onCandidate);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      pc!.addEventListener('icegatheringstatechange', () => {
        if (pc!.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { pc?.close(); } catch { /* noop */ }
    result.finishedAt = performance.now();
    result.iceGatheringDurationMs = Math.round(result.finishedAt - startedAt);
  }
  return result;
}

function CandidateBadge({ type }: { type: string }) {
  const palette: Record<string, string> = {
    host: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    srflx: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    prflx: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    relay: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  };
  const cls = palette[type] ?? 'bg-white/10 text-iv-muted border-white/10';
  return <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border ${cls}`}>{type}</span>;
}

export default function DiagView() {
  const [iceServers, setIceServers] = useState<RTCIceServer[] | null>(null);
  const [loadingServers, setLoadingServers] = useState(true);
  const [serversError, setServersError] = useState<string | null>(null);
  const [probeAll, setProbeAll] = useState<ProbeResult | null>(null);
  const [probeRelay, setProbeRelay] = useState<ProbeResult | null>(null);
  const [running, setRunning] = useState(false);

  const refreshIceServers = useCallback(async () => {
    setLoadingServers(true);
    setServersError(null);
    try {
      const servers = await loadIceServers();
      setIceServers(servers);
    } catch (err) {
      setServersError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingServers(false);
    }
  }, []);

  useEffect(() => {
    void refreshIceServers();
  }, [refreshIceServers]);

  const runProbes = useCallback(async () => {
    if (!iceServers) return;
    setRunning(true);
    setProbeAll(null);
    setProbeRelay(null);
    try {
      const all = await runIceProbe(iceServers, 'all');
      setProbeAll(all);
      const relay = await runIceProbe(iceServers, 'relay-only');
      setProbeRelay(relay);
    } finally {
      setRunning(false);
    }
  }, [iceServers]);

  const turnConfigured = useMemo(() => {
    if (!iceServers) return false;
    return iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => typeof u === 'string' && (u.startsWith('turn:') || u.startsWith('turns:')));
    });
  }, [iceServers]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-iv-text">Diagnóstico WebRTC</h2>
        <p className="text-sm text-iv-muted mt-1">
          Ferramenta interna para validar conectividade ICE/TURN antes/depois de mudanças
          de infraestrutura. Os testes não interferem em aulas em andamento.
        </p>
      </div>

      {/* ── ICE servers card ─────────────────────────────────────────────── */}
      <section className="glass-panel p-5 space-y-3">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-iv-text flex items-center gap-2">
            <Globe size={16} /> ICE servers configurados
          </h3>
          <Button variant="ghost" size="sm" onClick={refreshIceServers} disabled={loadingServers}>
            <RefreshCw size={14} className={loadingServers ? 'animate-spin' : ''} />
            Recarregar
          </Button>
        </header>

        {loadingServers ? (
          <div className="flex items-center gap-2 text-iv-muted text-sm">
            <Loader2 size={14} className="animate-spin" /> Buscando credenciais…
          </div>
        ) : serversError ? (
          <div className="flex items-start gap-2 text-rose-400 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Falha ao obter credenciais.</p>
              <p className="text-xs text-iv-muted">{serversError}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              {turnConfigured ? (
                <>
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span className="text-emerald-300">TURN configurado — fallback para NAT simétrico disponível.</span>
                </>
              ) : (
                <>
                  <AlertCircle size={16} className="text-amber-400" />
                  <span className="text-amber-300">Apenas STUN. Usuários atrás de NAT simétrico (4G/corporativo) podem falhar.</span>
                </>
              )}
            </div>
            <ul className="space-y-1.5">
              {iceServers?.map((s, i) => {
                const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
                return (
                  <li key={i} className="text-xs font-mono text-iv-muted bg-iv-bg/40 rounded p-2 border border-white/5 break-all">
                    {urls.join(', ')}
                    {s.username && <span className="text-iv-muted/60"> · user={s.username.slice(0, 16)}…</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* ── Probe runner ─────────────────────────────────────────────────── */}
      <section className="glass-panel p-5 space-y-4">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-iv-text flex items-center gap-2">
            <Shield size={16} /> Teste de candidatos ICE
          </h3>
          <Button onClick={runProbes} disabled={!iceServers || running} size="sm">
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? 'Executando…' : 'Rodar teste'}
          </Button>
        </header>
        <p className="text-xs text-iv-muted">
          Cria duas <code className="font-mono text-iv-text/80">RTCPeerConnection</code> de teste:
          uma com política <code className="font-mono">all</code> (host + srflx + relay) e outra
          forçando <code className="font-mono">relay</code>. Se a segunda gerar candidatos,
          o servidor TURN está acessível.
        </p>

        {probeAll && <ProbeResultCard title="Política: all (modo normal)" result={probeAll} />}
        {probeRelay && <ProbeResultCard title="Política: relay-only (validação TURN)" result={probeRelay} expectRelay />}
      </section>

      {/* ── Cheatsheet ───────────────────────────────────────────────────── */}
      <section className="glass-panel p-5 space-y-2 text-xs text-iv-muted">
        <p className="text-iv-text font-semibold text-sm">Como interpretar</p>
        <p><CandidateBadge type="host" /> = IP local da máquina (LAN). Conecta apenas mesma rede.</p>
        <p><CandidateBadge type="srflx" /> = IP público obtido via STUN. Funciona na maioria dos NATs domésticos.</p>
        <p><CandidateBadge type="relay" /> = mídia roteada via TURN. Único caminho para NAT simétrico (corporativo / carrier 4G).</p>
        <p className="pt-1">
          Se a coluna direita do segundo teste estiver vazia, o TURN não está acessível e clientes
          em rede restrita não conseguirão entrar nas aulas.
        </p>
      </section>
    </div>
  );
}

function ProbeResultCard({
  title,
  result,
  expectRelay = false,
}: {
  title: string;
  result: ProbeResult;
  expectRelay?: boolean;
}) {
  const types = result.candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.type] = (acc[c.type] ?? 0) + 1;
    return acc;
  }, {});
  const success = expectRelay ? result.hasRelay : result.candidates.length > 0;

  return (
    <div className="rounded-lg border border-white/5 bg-iv-bg/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-iv-text">{title}</p>
        <span className={`text-xs ${success ? 'text-emerald-300' : 'text-rose-300'}`}>
          {success ? '✓ ok' : '✗ falhou'} · {result.iceGatheringDurationMs} ms
        </span>
      </div>
      {result.error && (
        <p className="text-xs text-rose-300">{result.error}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(types).map(([type, count]) => (
          <span key={type} className="inline-flex items-center gap-1 text-[11px] bg-white/5 px-1.5 py-0.5 rounded">
            <CandidateBadge type={type} /> × {count}
          </span>
        ))}
        {result.candidates.length === 0 && !result.error && (
          <span className="text-xs text-iv-muted">Nenhum candidato coletado.</span>
        )}
      </div>
      {result.candidates.length > 0 && (
        <details className="text-[11px] font-mono text-iv-muted">
          <summary className="cursor-pointer text-iv-text/70">Ver todos ({result.candidates.length})</summary>
          <ul className="mt-1 space-y-0.5 max-h-40 overflow-auto">
            {result.candidates.map((c) => (
              <li key={c.id} className="break-all">
                <CandidateBadge type={c.type} /> {c.protocol} {c.address}:{c.port}
                {c.relatedAddress && <span className="opacity-60"> via {c.relatedAddress}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
