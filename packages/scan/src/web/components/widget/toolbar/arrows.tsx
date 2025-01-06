import { memo } from 'preact/compat';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Store } from '~core/index';
import { Icon } from '~web/components/icon';
import {
  type InspectableElement,
  getInspectableElements,
} from '~web/components/inspector/utils';
import { cn } from '~web/utils/helpers';

export const Arrows = memo(() => {
  const refButtonPrevious = useRef<HTMLButtonElement>(null);
  const refButtonNext = useRef<HTMLButtonElement>(null);
  const refAllElements = useRef<Array<InspectableElement>>([]);

  const [shouldRender, setShouldRender] = useState(false);

  const findNextElement = useCallback(
    (currentElement: HTMLElement, direction: 'next' | 'previous') => {
      const currentIndex = refAllElements.current.findIndex(
        (item) => item.element === currentElement,
      );
      if (currentIndex === -1) return null;

      const nextIndex = currentIndex + (direction === 'next' ? 1 : -1);
      return refAllElements.current[nextIndex]?.element || null;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: no deps
  const onPreviousFocus = useCallback(() => {
    const currentState = Store.inspectState.value;
    if (currentState.kind !== 'focused' || !currentState.focusedDomElement)
      return;

    const prevElement = findNextElement(
      currentState.focusedDomElement,
      'previous',
    );
    if (prevElement) {
      Store.inspectState.value = {
        kind: 'focused',
        focusedDomElement: prevElement,
      };
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: no deps
  const onNextFocus = useCallback(() => {
    const currentState = Store.inspectState.value;
    if (currentState.kind !== 'focused' || !currentState.focusedDomElement)
      return;

    const nextElement = findNextElement(currentState.focusedDomElement, 'next');
    if (nextElement) {
      Store.inspectState.value = {
        kind: 'focused',
        focusedDomElement: nextElement,
      };
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: no deps
  useEffect(() => {
    const unsubscribe = Store.inspectState.subscribe((state) => {
      if (state.kind === 'focused') {
        refAllElements.current = getInspectableElements();
        setShouldRender(true);
        if (refButtonPrevious.current) {
          const hasPrevious = !!findNextElement(
            state.focusedDomElement,
            'previous',
          );
          refButtonPrevious.current.classList.toggle(
            'opacity-50',
            !hasPrevious,
          );
          refButtonPrevious.current.classList.toggle(
            'cursor-not-allowed',
            !hasPrevious,
          );
        }
        if (refButtonNext.current) {
          const hasNext = !!findNextElement(state.focusedDomElement, 'next');
          refButtonNext.current.classList.toggle('opacity-50', !hasNext);
          refButtonNext.current.classList.toggle(
            'cursor-not-allowed',
            !hasNext,
          );
        }
      }

      if (state.kind === 'inspecting') {
        setShouldRender(true);
      }

      if (state.kind === 'inspect-off') {
        refAllElements.current = [];
      }

      if (state.kind === 'uninitialized') {
        Store.inspectState.value = {
          kind: 'inspect-off',
        };
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (!shouldRender) return null;

  return (
    <div
      className={cn(
        'flex items-stretch justify-between',
        'ml-auto',
        'border-l-1 border-white/10 text-[#999]',
        'overflow-hidden',
      )}
    >
      <button
        ref={refButtonPrevious}
        type="button"
        title="Previous element"
        onClick={onPreviousFocus}
        className="button flex cursor-not-allowed items-center justify-center px-3 opacity-50"
      >
        <Icon name="icon-previous" />
      </button>
      <button
        ref={refButtonNext}
        type="button"
        title="Next element"
        onClick={onNextFocus}
        className="button flex cursor-not-allowed items-center justify-center px-3 opacity-50"
      >
        <Icon name="icon-next" />
      </button>
    </div>
  );
});
