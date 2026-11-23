import { Icon } from '../components/Icon';
import { useRefresh } from '../components/RefreshBanner';
import { REFRESH_COPY } from '../lib/copy';
import { APPBAR_BUTTON } from './appBarButton';

/**
 * The app bar's Refresh: starts a run for every source. While a run this tab follows is going it reads "Refreshing…" and
 * keeps focus (aria-disabled, not disabled), as every refresh button does. On a phone only the icon stays visible; the
 * words remain for assistive technology.
 */
export function RefreshButton() {
  const { refresh, isBusy, description } = useRefresh();
  return (
    <button
      type="button"
      title={description}
      aria-busy={isBusy || undefined}
      aria-disabled={isBusy || undefined}
      onClick={() => refresh()}
      className={`${APPBAR_BUTTON} cursor-pointer text-ink hover:bg-canvas aria-disabled:cursor-default aria-disabled:opacity-70`}
    >
      <Icon name={isBusy ? 'spinner' : 'refresh'} />
      <span className="sr-only min-[720px]:not-sr-only">
        {isBusy ? REFRESH_COPY.refreshing : REFRESH_COPY.refresh}
      </span>
    </button>
  );
}
