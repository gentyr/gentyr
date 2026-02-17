import React from 'react';

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[GENTYR Dashboard] Render error:', error, info);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="section" style={{ margin: '20px' }}>
          <div className="section-title text-red">Dashboard Error</div>
          <p className="text-muted" style={{ marginBottom: '8px' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            className="refresh-btn"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Reset Dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
