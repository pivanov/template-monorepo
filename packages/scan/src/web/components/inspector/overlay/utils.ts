import { type Fiber, FunctionComponentTag, type MemoizedState } from 'bippy';
import { isEqual } from '~core/utils';

interface ContextDependency<T = unknown> {
  context: ReactContext<T>;
  next: ContextDependency<T> | null;
}

interface ContextValue {
  displayValue: Record<string, unknown>;
  rawValue?: unknown;
  isUserContext?: boolean;
}

interface ReactContext<T = unknown> {
  $$typeof: symbol;
  Consumer: ReactContext<T>;
  Provider: {
    $$typeof: symbol;
    _context: ReactContext<T>;
  };
  _currentValue: T;
  _currentValue2: T;
  displayName?: string;
}

const stateChangeCounts = new Map<string, number>();
const propsChangeCounts = new Map<string, number>();
const contextChangeCounts = new Map<string, number>();
let lastRenderedStates = new WeakMap<Fiber>();

const STATE_NAME_REGEX = /\[(?<name>\w+),\s*set\w+\]/g;
const PROPS_ORDER_REGEX = /\(\s*{\s*(?<props>[^}]+)\s*}\s*\)/;

const ensureRecord = (
  value: unknown,
  seen = new WeakSet(),
): Record<string, unknown> => {
  if (value === null || value === undefined) {
    return {};
  }

  if (value instanceof Element) {
    return {
      type: 'Element',
      tagName: value.tagName.toLowerCase(),
    };
  }

  if (typeof value === 'function') {
    return { type: 'function', name: value.name || 'anonymous' };
  }

  if (
    value &&
    (value instanceof Promise || (typeof value === 'object' && 'then' in value))
  ) {
    return { type: 'promise' };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return { type: 'circular' };
    }

    if (Array.isArray(value)) {
      seen.add(value);
      const safeArray = value.map((item) => ensureRecord(item, seen));
      return { type: 'array', length: value.length, items: safeArray };
    }

    seen.add(value);

    const result: Record<string, unknown> = {};
    try {
      const keys = Object.keys(value);
      for (const key of keys) {
        try {
          const val = (value as Record<string, unknown>)[key];
          result[key] = ensureRecord(val, seen);
        } catch {
          result[key] = { type: 'error', message: 'Failed to access property' };
        }
      }
      return result;
    } catch {
      return { type: 'object' };
    }
  }

  return { value };
};

export const resetStateTracking = () => {
  stateChangeCounts.clear();
  propsChangeCounts.clear();
  contextChangeCounts.clear();
  lastRenderedStates = new WeakMap<Fiber>();
};

export const getStateChangeCount = (name: string): number =>
  stateChangeCounts.get(name) ?? 0;
export const getPropsChangeCount = (name: string): number =>
  propsChangeCounts.get(name) ?? 0;
export const getContextChangeCount = (name: string): number =>
  contextChangeCounts.get(name) ?? 0;

export const getStateNames = (fiber: Fiber): Array<string> => {
  const componentSource = fiber.type?.toString?.() || '';
  // Return the matches if we found any, otherwise return empty array
  // Empty array means we'll use numeric indices as fallback
  return componentSource
    ? Array.from(
        componentSource.matchAll(STATE_NAME_REGEX),
        (m: RegExpMatchArray) => m.groups?.name ?? '',
      )
    : [];
};

export const isDirectComponent = (fiber: Fiber): boolean => {
  if (!fiber || !fiber.type) return false;

  const isFunctionalComponent = typeof fiber.type === 'function';
  const isClassComponent = fiber.type?.prototype?.isReactComponent ?? false;

  if (!(isFunctionalComponent || isClassComponent)) return false;

  if (isClassComponent) {
    return true;
  }

  let memoizedState = fiber.memoizedState;
  while (memoizedState) {
    if (memoizedState.queue) {
      return true;
    }
    const nextState = memoizedState.next;
    if (!nextState) break;
    memoizedState = nextState;
  }

  return false;
};

export const getCurrentState = (fiber: Fiber | null) => {
  if (!fiber) return {};

  try {
    if (fiber.tag === FunctionComponentTag && isDirectComponent(fiber)) {
      return getCurrentFiberState(fiber) ?? {};
    }
  } catch {
    // Silently fail
  }
  return {};
};

export const getChangedState = (fiber: Fiber): Set<string> => {
  const changes = new Set<string>();
  if (!fiber || fiber.tag !== FunctionComponentTag || !isDirectComponent(fiber))
    return changes;

  try {
    const currentState = getCurrentFiberState(fiber);
    if (!currentState) return changes;

    if (!fiber.alternate) {
      lastRenderedStates.set(fiber, { ...currentState });
      return changes;
    }

    const lastState = lastRenderedStates.get(fiber);
    if (lastState) {
      for (const name of Object.keys(currentState)) {
        if (!isEqual(currentState[name], lastState[name])) {
          changes.add(name);
          if (lastState[name] !== undefined) {
            const existingCount = stateChangeCounts.get(name) ?? 0;
            stateChangeCounts.set(name, existingCount + 1);
          }
        }
      }
    }

    lastRenderedStates.set(fiber, { ...currentState });
    if (fiber.alternate) {
      lastRenderedStates.set(fiber.alternate, { ...currentState });
    }
  } catch {
    // Silently fail
  }

  return changes;
};

const getStateValue = (memoizedState: MemoizedState): unknown => {
  if (!memoizedState) return undefined;

  const queue = memoizedState.queue as { lastRenderedState: unknown } | null;
  if (queue) {
    return queue.lastRenderedState;
  }

  return memoizedState.memoizedState;
};

const getCurrentFiberState = (fiber: Fiber): Record<string, unknown> | null => {
  if (fiber.tag !== FunctionComponentTag || !isDirectComponent(fiber)) {
    return null;
  }

  const currentIsNewer = fiber.alternate
    ? (fiber.actualStartTime ?? 0) > (fiber.alternate.actualStartTime ?? 0)
    : true;

  let memoizedState = currentIsNewer
    ? fiber.memoizedState
    : (fiber.alternate?.memoizedState ?? fiber.memoizedState);

  if (!memoizedState) return null;

  const currentState: Record<string, unknown> = {};
  const stateNames = getStateNames(fiber);
  let index = 0;

  while (memoizedState) {
    if (memoizedState.queue) {
      const name = stateNames[index] || `{${index}}`;
      try {
        currentState[name] = getStateValue(memoizedState);
      } catch {
        // Silently fail
      }
      index++;
    }
    const nextState = memoizedState.next;
    if (!nextState) break;
    memoizedState = nextState;
  }

  return currentState;
};

export const getPropsOrder = (fiber: Fiber): Array<string> => {
  const componentSource = fiber.type?.toString?.() || '';
  const match = componentSource.match(PROPS_ORDER_REGEX);
  if (!match?.groups?.props) return [];

  return match.groups.props
    .split(',')
    .map((prop: string) => prop.trim().split(':')[0].split('=')[0].trim())
    .filter(Boolean);
};

export const getCurrentProps = (fiber: Fiber): Record<string, unknown> => {
  const currentIsNewer = fiber?.alternate
    ? (fiber.actualStartTime ?? 0) > (fiber.alternate?.actualStartTime ?? 0)
    : true;

  const baseProps = currentIsNewer
    ? fiber.memoizedProps || fiber.pendingProps
    : fiber.alternate?.memoizedProps ||
      fiber.alternate?.pendingProps ||
      fiber.memoizedProps;

  return { ...baseProps };
};

export const getChangedProps = (fiber: Fiber): Set<string> => {
  const changes = new Set<string>();
  if (!fiber.alternate) return changes;

  const previousProps = fiber.alternate.memoizedProps ?? {};
  const currentProps = fiber.memoizedProps ?? {};

  const propsOrder = getPropsOrder(fiber);
  const orderedProps = [...propsOrder, ...Object.keys(currentProps)];
  const uniqueOrderedProps = [...new Set(orderedProps)];

  for (const key of uniqueOrderedProps) {
    if (key === 'children') continue;
    if (!(key in currentProps)) continue;

    const currentValue = currentProps[key];
    const previousValue = previousProps[key];

    if (!isEqual(currentValue, previousValue)) {
      changes.add(key);

      if (typeof currentValue !== 'function') {
        const count = (propsChangeCounts.get(key) ?? 0) + 1;
        propsChangeCounts.set(key, count);
      }
    }
  }

  for (const key in previousProps) {
    if (key === 'children') continue;
    if (!(key in currentProps)) {
      changes.add(key);
      const count = (propsChangeCounts.get(key) ?? 0) + 1;
      propsChangeCounts.set(key, count);
    }
  }

  return changes;
};

export const getAllFiberContexts = (
  fiber: Fiber,
): Map<string, ContextValue> => {
  const contexts = new Map<string, ContextValue>();
  if (!fiber) return contexts;

  const findProviderValue = (
    contextType: ReactContext,
  ): { value: ContextValue; displayName: string } | null => {
    let searchFiber: Fiber | null = fiber;
    while (searchFiber) {
      if (searchFiber.type?.Provider) {
        const providerValue = searchFiber.memoizedProps?.value;
        const pendingValue = searchFiber.pendingProps?.value;
        const currentValue = contextType._currentValue;

        // For built-in contexts
        if (contextType.displayName) {
          if (currentValue === null) {
            return null;
          }
          return {
            value: {
              displayValue: ensureRecord(currentValue),
              isUserContext: false,
              rawValue: currentValue,
            },
            displayName: contextType.displayName,
          };
        }

        const providerName =
          searchFiber.type.name?.replace('Provider', '') ??
          searchFiber._debugOwner?.type?.name ??
          'Unnamed';

        const valueToUse =
          pendingValue !== undefined
            ? pendingValue
            : providerValue !== undefined
              ? providerValue
              : currentValue;

        return {
          value: {
            displayValue: ensureRecord(valueToUse),
            isUserContext: true,
            rawValue: valueToUse,
          },
          displayName: providerName,
        };
      }
      searchFiber = searchFiber.return;
    }
    return null;
  };

  let currentFiber: Fiber | null = fiber;
  while (currentFiber) {
    if (currentFiber.dependencies?.firstContext) {
      let contextItem = currentFiber.dependencies
        .firstContext as ContextDependency | null;
      while (contextItem !== null) {
        const context = contextItem.context;
        if (context && '_currentValue' in context) {
          const result = findProviderValue(context);
          if (result) {
            contexts.set(result.displayName, result.value);
          }
        }
        contextItem = contextItem.next;
      }
    }
    currentFiber = currentFiber.return;
  }

  return contexts;
};

export const getCurrentContext = (fiber: Fiber) => {
  const contexts = getAllFiberContexts(fiber);
  const contextObj: Record<string, unknown> = {};

  contexts.forEach((value, contextName) => {
    contextObj[contextName] = value.displayValue;
  });

  return contextObj;
};

const getContextDisplayName = (contextType: unknown): string => {
  if (typeof contextType !== 'object' || contextType === null) {
    return String(contextType);
  }

  const typedContext = contextType as Partial<
    ReactContext & {
      Provider: { displayName?: string };
      Consumer: { displayName?: string };
      type: { name?: string };
    }
  >;

  return (
    typedContext.displayName ??
    typedContext.Provider?.displayName ??
    typedContext.Consumer?.displayName ??
    typedContext.type?.name?.replace('Provider', '') ??
    'Unnamed'
  );
};

export const getChangedContext = (fiber: Fiber): Set<string> => {
  const changes = new Set<string>();
  if (!fiber.alternate) return changes;

  const currentContexts = getAllFiberContexts(fiber);

  currentContexts.forEach((_currentValue, contextType) => {
    const contextName = getContextDisplayName(contextType);

    let searchFiber: Fiber | null = fiber;
    let providerFiber: Fiber | null = null;

    while (searchFiber) {
      if (searchFiber.type?.Provider) {
        providerFiber = searchFiber;
        break;
      }
      searchFiber = searchFiber.return;
    }

    if (providerFiber?.alternate) {
      const currentProviderValue = providerFiber.memoizedProps?.value;
      const alternateValue = providerFiber.alternate.memoizedProps?.value;

      if (!isEqual(currentProviderValue, alternateValue)) {
        changes.add(contextName);
        contextChangeCounts.set(
          contextName,
          (contextChangeCounts.get(contextName) ?? 0) + 1,
        );
      }
    }
  });

  return changes;
};
