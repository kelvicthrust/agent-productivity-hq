import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { useState } from 'react';
import manifest from '../../../package.json' with { type: 'json' };
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { APPBAR_BUTTON } from './appBarButton';
import { PRODUCT_NAME } from './routes';

const title = `About ${PRODUCT_NAME}`;
const repository = 'https://github.com/kelvicthrust/agent-productivity-hq';
const links = [
  { label: 'GitHub repository', href: repository },
  { label: 'Release notes', href: `${repository}/releases` },
  { label: 'Setup and troubleshooting', href: `${repository}/blob/main/docs/delivery/setup.md` },
];

export function AboutButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={title}
        aria-haspopup="dialog"
        title={title}
        className={`${APPBAR_BUTTON} cursor-pointer text-ink hover:bg-canvas`}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <Icon name="info" />
      </button>
      <Dialog isOpen={open} onOpenChange={setOpen} aria-label={title} width={420}>
        {open && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <DialogHeader
              title={<span className="font-display text-title-section text-ink">{title}</span>}
              startContent={<BrandMark />}
              onOpenChange={setOpen}
              className="max-[719px]:[&_button]:min-h-11 max-[719px]:[&_button]:min-w-11"
            />
            <div className="min-h-0 overflow-y-auto text-copy">
              <p className="pb-3 text-ink-muted">
                A local dashboard for agent usage and merged GitHub pull requests.
              </p>
              <dl className="flex justify-between gap-2 border-t border-border py-2">
                <dt className="text-ink-muted">App version</dt>
                <dd className="font-semibold tabular-nums">{manifest.version}</dd>
              </dl>
              <ul>
                {links.map(({ href, label }) => (
                  <li key={href} className="border-t border-border">
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-11 items-center justify-between gap-2 py-2"
                    >
                      {label}
                      <Icon name="external" className="shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
              <div className="border-t border-border pt-2 text-caption text-ink-muted">
                Made with ❤️ by{' '}
                <a
                  href="https://github.com/kelvicthrust"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center min-[720px]:min-h-7"
                >
                  kelvicthrust
                </a>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
