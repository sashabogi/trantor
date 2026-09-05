import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type Props = { area: string; children: ReactNode };
type State = { attempt: number; error: Error | null };

export class SettingsBoundary extends Component<Props, State> {
  state: State = { attempt: 0, error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.area} failed to render`, error, info.componentStack);
  }

  private retry = () => {
    this.setState(current => ({ attempt: current.attempt + 1, error: null }));
  };

  render() {
    const { attempt, error } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <div role="alert" className="tr-card-ghost flex min-h-40 items-center justify-center px-6 py-5 text-center text-[12.5px] leading-relaxed">
        <div className="max-w-[460px]">
          <div>{this.props.area} failed to render. The rest of the app is still available.</div>
          <div className="tr-mono mt-2 break-words text-[11.5px] text-[var(--color-tr-fail)]">{error.message}</div>
          <button type="button" onClick={this.retry} className="tr-input mt-3">Retry</button>
        </div>
      </div>
    );
  }
}
