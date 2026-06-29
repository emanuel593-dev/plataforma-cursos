import React, { Component } from 'react';
import { AlertCircle } from 'lucide-react';

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; message: string; }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    let friendly = 'Ocorreu um erro crítico no sistema.';
    if (this.state.message.toLowerCase().includes('permission')) {
      friendly = 'Permissão negada. Verifique se você está logado corretamente.';
    } else if (this.state.message.toLowerCase().includes('network') || this.state.message.toLowerCase().includes('fetch')) {
      friendly = 'Erro de conexão. Verifique sua internet e tente novamente.';
    }

    return (
      <div className="min-h-screen bg-hw-bg flex items-center justify-center p-8">
        <div className="glass-panel p-8 max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-white uppercase tracking-tight">System Crash Detected</h2>
          <p className="text-sm text-hw-muted font-mono leading-relaxed">{friendly}</p>
          <div className="bg-black/40 p-4 rounded-xl text-[10px] font-mono text-red-400 text-left overflow-x-auto">
            {this.state.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-3 bg-hw-accent text-hw-bg rounded-xl font-bold uppercase tracking-widest hover:bg-hw-accent/90 transition-all"
          >
            Reboot System
          </button>
        </div>
      </div>
    );
  }
}
