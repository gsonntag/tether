// A part of the page that throws while rendering shows a small inline note instead of taking the
// whole app down with it (one odd transcript part must never blank the screen).

import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: (error: Error) => ReactNode; resetKey?: unknown }, { error?: Error; key?: unknown }> {
  state: { error?: Error; key?: unknown } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error?: Error; key?: unknown }) {
    // New content (the part changed): try again.
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("render failed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback ? this.props.fallback(this.state.error) : <div className="t-inline-status error">This part couldn't be shown ({this.state.error.message}).</div>;
  }
}
