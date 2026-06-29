import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[IV ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center py-20 px-4 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-red-500/15 text-red-400 flex items-center justify-center">
            <AlertTriangle size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-iv-text mb-1">Algo deu errado</h2>
            <p className="text-sm text-iv-muted max-w-sm">
              Ocorreu um erro inesperado. Tente recarregar a página.
            </p>
          </div>
          {import.meta.env.DEV && this.state.error && (
            <pre className="text-xs text-red-400/60 font-mono max-w-md overflow-auto px-3 py-2 bg-red-500/5 rounded-xl border border-red-500/10">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-iv-accent/15 text-iv-accent text-sm font-medium hover:bg-iv-accent/25 transition-colors"
          >
            <RefreshCw size={14} />
            Tentar novamente
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
