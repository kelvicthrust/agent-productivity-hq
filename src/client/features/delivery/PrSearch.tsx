import { TextInput } from '@astryxdesign/core/TextInput';
import { useEffect, useState } from 'react';
import { DELIVERY_COPY } from './copy';

/** How long typing pauses before the search reaches the URL and the server. */
const PAUSE_MS = 250;

/**
 * The search box. What is typed is local, so every key shows at once; the URL (which owns `q`, TECH › State ownership) and so
 * the request follow a pause later. The box follows the URL back when something else changes it (Back, a link from Usage's
 * "#316"), and ignores the echo of its own write, so a character typed while the URL catches up is never overwritten.
 */
export function PrSearch({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  // The value last seen from the URL, and the value last written to it: a change that is not ours is shown.
  const [seen, setSeen] = useState(value);
  const [written, setWritten] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value !== written) {
      setWritten(value);
      setDraft(value);
    }
  }

  useEffect(() => {
    if (draft === written) return undefined;
    const timer = setTimeout(() => {
      setWritten(draft);
      onCommit(draft);
    }, PAUSE_MS);
    return () => clearTimeout(timer);
  }, [draft, written, onCommit]);

  return (
    <TextInput
      type="search"
      label={DELIVERY_COPY.search.label}
      isLabelHidden
      placeholder={DELIVERY_COPY.search.placeholder}
      value={draft}
      onChange={setDraft}
      enterKeyHint="search"
      autoComplete="off"
      hasSpellCheck={false}
      // On a phone the box is 44px high and its text 16px, so it is a 44px target and iOS does not zoom on focus (design-to-code
      // "14px inputs zoom on iOS", Touch targets). The control is the box; the input inside is what a finger lands on, so both grow.
      controlClassName="max-[719px]:h-11 max-[719px]:text-[16px]"
      containerClassName="w-full min-[720px]:w-72 max-[719px]:[&_input]:min-h-11"
    />
  );
}
