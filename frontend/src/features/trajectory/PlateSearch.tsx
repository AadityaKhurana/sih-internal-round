import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { usePlateSearch } from '@/api/hooks';
import { SearchIcon } from '@/components/icons';
import { Badge, Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatPlate, isValidPlate, normalizePlate } from '@/lib/plate';
import { formatRelative } from '@/lib/time';
import './trajectory.css';

export interface PlateSearchProps {
  value: string;
  onSubmit: (plate: string) => void;
  autoFocus?: boolean;
}

/**
 * Plate search with typeahead.
 *
 * Implements the ARIA combobox pattern rather than a styled div soup: arrow keys
 * move through suggestions, Enter picks one, Escape closes, and the active option
 * is announced. An operator under time pressure should be able to drive this from
 * the keyboard alone.
 *
 * Input is normalised as it is typed (uppercased, separators stripped) so
 * "ka 01 ab 1234" and "KA01AB1234" are the same search — matching the rule the
 * OCR normaliser and the `plates` table use.
 */
export function PlateSearch({ value, onSubmit, autoFocus = false }: PlateSearchProps) {
  const listId = useId();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [debounced, setDebounced] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep in step when the plate changes from elsewhere (an alert's "Trajectory"
  // action, or a shared URL).
  useEffect(() => {
    setQuery(value);
    setDebounced(value);
  }, [value]);

  // Debounced so typing a full plate is one request at the end, not eight.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 220);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: suggestions = [], isFetching } = usePlateSearch(debounced, open);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const normalized = normalizePlate(query);
  const looksValid = normalized.length === 0 || isValidPlate(normalized);

  const hint = useMemo(() => {
    if (normalized.length === 0) return 'Enter a plate, e.g. KA 01 AB 1234.';
    if (!looksValid) {
      return 'Not a recognised Indian series — searching anyway, since OCR can misread a plate.';
    }
    return null;
  }, [normalized, looksValid]);

  const commit = (plate: string) => {
    const next = normalizePlate(plate);
    if (next.length === 0) return;
    setQuery(next);
    setOpen(false);
    setActiveIndex(-1);
    onSubmit(next);
  };

  return (
    <div className="plate-search" ref={containerRef}>
      <label className="ui-field__label" htmlFor={`${listId}-input`}>
        Plate
      </label>
      <div className="plate-search__input-wrap">
        <span className="plate-search__icon">
          <SearchIcon size={14} />
        </span>
        <input
          id={`${listId}-input`}
          ref={inputRef}
          className="ui-input ui-input--mono plate-search__input"
          placeholder="KA01AB1234"
          value={query}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
          }
          onChange={(event) => {
            setQuery(normalizePlate(event.target.value));
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, -1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const picked = suggestions[activeIndex];
              commit(picked ? picked.normalized_plate : query);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
        />
        {isFetching ? (
          <span className="plate-search__spinner">
            <Spinner size={13} />
          </span>
        ) : null}
      </div>

      {hint ? <span className="ui-field__hint">{hint}</span> : null}

      {open && debounced.trim().length >= 2 ? (
        <ul className="plate-search__list" id={listId} role="listbox" aria-label="Matching plates">
          {suggestions.length === 0 && !isFetching ? (
            <li className="plate-search__empty">
              No plate in the dataset contains “{debounced}”.
            </li>
          ) : null}

          {suggestions.map((suggestion, index) => (
            <li key={suggestion.plate_id} role="none">
              <button
                type="button"
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={cx(
                  'plate-search__option',
                  index === activeIndex && 'is-active',
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(suggestion.normalized_plate)}
              >
                <span className="plate-search__plate">
                  {formatPlate(suggestion.normalized_plate)}
                </span>
                {suggestion.is_blacklisted ? (
                  <Badge tone="danger">blacklisted</Badge>
                ) : null}
                <span className="plate-search__meta">
                  {suggestion.sighting_count} sighting
                  {suggestion.sighting_count === 1 ? '' : 's'}
                  {suggestion.last_seen_at
                    ? ` · ${formatRelative(suggestion.last_seen_at)}`
                    : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
