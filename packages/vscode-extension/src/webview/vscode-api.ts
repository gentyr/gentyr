declare global {
  interface Window {
    acquireVsCodeApi(): {
      postMessage(message: unknown): void;
      setState(state: unknown): void;
      getState(): unknown;
    };
  }
}

class VSCodeAPI {
  private readonly api = window.acquireVsCodeApi();

  postMessage(message: unknown): void {
    this.api.postMessage(message);
  }

  setState(state: unknown): void {
    this.api.setState(state);
  }

  getState(): unknown {
    return this.api.getState();
  }
}

export const vscode = new VSCodeAPI();
