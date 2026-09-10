// A terminal talks to a pty, a WebGL context, and a Rust bridge on every tab switch; a throw there
// unmounts the whole React tree and leaves a blank, frozen window with the process still alive
// and unrecoverable without quitting. This error boundary keeps the failure inside the pane,
// says what broke, and offers a retry that remounts just the pane.
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; onRetry?: () => void };
type State = { error: Error | null };

export class PaneBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The window is the only place this is visible on a release build, so say it plainly.
    console.error("terminal pane failed", error, info.componentStack);
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="tr-card-ghost max-w-[460px] px-6 py-5 text-center text-[12.5px] leading-relaxed">
          <div>This terminal failed to render. The rest of the app is fine.</div>
          <div className="tr-mono mt-2 break-words text-[11.5px] text-tr-danger">{error.message}</div>
          <button
            type="button"
            onClick={this.retry}
            className="mt-3 rounded-[8px] bg-tr-ok px-3 py-1.5 text-[12px] font-semibold text-[#07130f]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
