// What a plugin draws (a pane's body, the right sidebar's panel, a status
// bar item) inside an error boundary: a plugin that fails while drawing
// shows what failed and Try Again in its place, and the rest of the page
// goes on. Try Again, or a change of resetKey (another view, another
// panel), draws it afresh.
import { Component, Fragment, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { t } from '../i18n';

interface Props {
  /** The plugin's name, as the user reads it. */
  plugin: string;
  /** A status bar item: a small button instead of a message. */
  compact?: boolean;
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error?: Error;
  attempt: number;
}

export class PluginBoundary extends Component<Props, State> {
  state: State = { attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error(`plugin ${this.props.plugin} failed`, error);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.retry();
  }

  retry = () => this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }));

  render() {
    const { error, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    const vars = { plugin: this.props.plugin, error: error.message || error.name };
    if (this.props.compact) {
      const label = `${t('plugins.crashedShort', vars)} ${t('plugins.retry')}`;
      return (
        <button className="plugin-error-item" title={label} aria-label={label} onClick={this.retry}>
          <TriangleAlert />
        </button>
      );
    }
    return (
      <div className="plugin-error" role="alert">
        <p>{t('plugins.crashed', vars)}</p>
        <button className="btn" onClick={this.retry}>
          <RotateCcw /> {t('plugins.retry')}
        </button>
      </div>
    );
  }
}
