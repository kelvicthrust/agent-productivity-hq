import { Button } from '@astryxdesign/core/Button';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import type { Repo } from '../../../shared/contracts/repos';
import { COPY } from './copy';

// The repo list: tick the repos to look at, or None to look at all of them. A tick applies at once (the URL is the
// state), so Done only closes the panel.

export type RepoList =
  | { status: 'pending' }
  | { status: 'error'; retry: () => void }
  | { status: 'success'; repos: readonly Repo[] };

interface Props {
  list: RepoList;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  onDone: () => void;
}

/** Selected ids the list does not know (a stopped repo, a typo in a shared link) stay visible so they can be unticked. */
function rowsFor(repos: readonly Repo[], selected: readonly string[]) {
  const known = new Set(repos.map((repo) => repo.id));
  return [
    ...repos.map((repo) => ({
      id: repo.id,
      name: repo.displayName,
      note: repo.accessState === 'inaccessible' ? COPY.inaccessible : null,
      // An inaccessible repo has no history to show, so it cannot be newly picked; one already picked can be cleared.
      locked: repo.accessState === 'inaccessible' && !selected.includes(repo.id),
    })),
    ...selected
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id, note: COPY.notTracked, locked: false })),
  ];
}

export function RepoPanel({ list, selected, onChange, onDone }: Props) {
  const rows = list.status === 'success' ? rowsFor(list.repos, selected) : [];
  return (
    <div className="flex flex-col gap-3">
      {list.status === 'pending' && (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loadingRepos}
        </p>
      )}
      {list.status === 'error' && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-copy text-danger">
            {COPY.reposFailed}
          </p>
          <Button
            label={COPY.retry}
            size="sm"
            variant="secondary"
            className="max-[719px]:min-h-11"
            onClick={list.retry}
          />
        </div>
      )}
      {list.status === 'success' && rows.length === 0 && (
        <p className="text-copy text-ink-muted">{COPY.noRepos}</p>
      )}
      {rows.length > 0 && (
        <CheckboxList
          label={COPY.repoList}
          value={[...selected]}
          onChange={onChange}
          density="compact"
        >
          {rows.map((row) => (
            <CheckboxListItem
              key={row.id}
              value={row.id}
              label={row.note === null ? row.name : `${row.name} ${row.note}`}
              isDisabled={row.locked}
            />
          ))}
        </CheckboxList>
      )}
      <p className="text-caption text-ink-muted">{COPY.repoHint}</p>
      <div className="flex justify-end gap-2">
        <Button
          label={COPY.allRepos}
          size="sm"
          variant="secondary"
          className="max-[719px]:min-h-11"
          onClick={() => onChange([])}
        />
        <Button
          label={COPY.done}
          size="sm"
          variant="primary"
          className="max-[719px]:min-h-11"
          onClick={onDone}
        />
      </div>
    </div>
  );
}
