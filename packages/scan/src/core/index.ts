import svgSprite from 'virtual:svg-sprite';
import { type Signal, signal } from '@preact/signals';
import {
  type Fiber,
  detectReactBuildType,
  getDisplayName,
  getRDTHook,
  getTimings,
  getType,
  isCompositeFiber,
  isInstrumentationActive,
  traverseFiber,
} from 'bippy';
import type { ComponentType } from 'preact';
import type { ReactNode } from 'preact/compat';
import { initReactScanOverlay } from 'src/outlines';
import { type RenderData, updateFiberRenderData } from '~core/utils';
import styles from '~web/assets/css/styles.css?inline';
import type { States } from '~web/components/inspector/utils';
import { createToolbar } from '~web/toolbar';
import { playGeigerClickSound } from '~web/utils/geiger';
import { readLocalStorage, saveLocalStorage } from '~web/utils/helpers';
import { log, logIntro } from '~web/utils/log';
import type { Outline } from '~web/utils/outline';
import { type Render, createInstrumentation } from './instrumentation';
import type { InternalInteraction } from './monitor/types';
import type { getSession } from './monitor/utils';

let toolbarContainer: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let audioContext: AudioContext | null = null;

export interface Options {
  /**
   * Enable/disable scanning
   *
   * Please use the recommended way:
   * enabled: process.env.NODE_ENV === 'development',
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Include children of a component applied with withScan
   *
   * @default true
   */
  includeChildren?: boolean;

  /**
   * Force React Scan to run in production (not recommended)
   *
   * @default false
   */
  dangerouslyForceRunInProduction?: boolean;

  /**
   * Enable/disable geiger sound
   *
   * @default true
   */
  playSound?: boolean;

  /**
   * Log renders to the console
   *
   * WARNING: This can add significant overhead when the app re-renders frequently
   *
   * @default false
   */
  log?: boolean;

  /**
   * Show toolbar bar
   *
   * If you set this to true, and set {@link enabled} to false, the toolbar will still show, but scanning will be disabled.
   *
   * @default true
   */
  showToolbar?: boolean;

  /**
   * Render count threshold, only show
   * when a component renders more than this
   *
   * @default 0
   */
  renderCountThreshold?: number;

  /**
   * Clear aggregated fibers after this time in milliseconds
   *
   * @default 5000
   */
  resetCountTimeout?: number;

  /**
   * Maximum number of renders for red indicator
   *
   * @default 20
   * @deprecated
   */
  maxRenders?: number;

  /**
   * Report data to getReport()
   *
   * @default false
   */
  report?: boolean;

  /**
   * Always show labels
   *
   * @default false
   */
  alwaysShowLabels?: boolean;

  /**
   * Animation speed
   *
   * @default "fast"
   */
  animationSpeed?: 'slow' | 'fast' | 'off';

  /**
   * Smoothly animate the re-render outline when the element moves
   *
   * @default true
   */
  smoothlyAnimateOutlines?: boolean;

  /**
   * Track unnecessary renders, and mark their outlines gray when detected
   *
   * An unnecessary render is defined as the component re-rendering with no change to the component's
   * corresponding dom subtree
   *
   *  @default false
   *  @warning tracking unnecessary renders can add meaningful overhead to react-scan
   */
  trackUnnecessaryRenders?: boolean;

  onCommitStart?: () => void;
  onRender?: (fiber: Fiber, renders: Array<Render>) => void;
  onCommitFinish?: () => void;
  onPaintStart?: (outlines: Array<Outline>) => void;
  onPaintFinish?: (outlines: Array<Outline>) => void;
}

export type MonitoringOptions = Pick<
  Options,
  | 'includeChildren'
  | 'enabled'
  | 'renderCountThreshold'
  | 'resetCountTimeout'
  | 'onCommitStart'
  | 'onCommitFinish'
  | 'onPaintStart'
  | 'onPaintFinish'
  | 'onRender'
>;

interface Monitor {
  pendingRequests: number;
  interactions: Array<InternalInteraction>;
  session: ReturnType<typeof getSession>;
  url: string | null;
  route: string | null;
  apiKey: string | null;
  commit: string | null;
  branch: string | null;
}

export interface StoreType {
  inspectState: Signal<States>;
  wasDetailsOpen: Signal<boolean>;
  lastReportTime: Signal<number>;
  isInIframe: Signal<boolean>;
  monitor: Signal<Monitor | null>;
  fiberRoots: WeakSet<Fiber>;
  reportData: WeakMap<Fiber, RenderData>;
  legacyReportData: Map<string, RenderData>;
}

export type OutlineKey = `${string}-${string}`;

export interface Internals {
  instrumentation: ReturnType<typeof createInstrumentation> | null;
  componentAllowList: WeakMap<ComponentType<unknown>, Options> | null;
  options: Signal<Options>;
  scheduledOutlines: Map<Fiber, Outline>; // we clear t,his nearly immediately, so no concern of mem leak on the fiber
  // outlines at the same coordinates always get merged together, so we pre-compute the merge ahead of time when aggregating in activeOutlines
  activeOutlines: Map<OutlineKey, Outline>; // we re-use the outline object on the scheduled outline
  onRender: ((fiber: Fiber, renders: Array<Render>) => void) | null;
  Store: StoreType;
}

export const Store: StoreType = {
  wasDetailsOpen: signal(true),
  isInIframe: signal(
    typeof window !== 'undefined' && window.self !== window.top,
  ),
  inspectState: signal<States>({
    kind: 'uninitialized',
  }),
  monitor: signal<Monitor | null>(null),
  fiberRoots: new WeakSet<Fiber>(),
  reportData: new WeakMap<Fiber, RenderData>(),
  legacyReportData: new Map<string, RenderData>(),
  lastReportTime: signal(0),
};

export const ReactScanInternals: Internals = {
  instrumentation: null,
  componentAllowList: null,
  options: signal({
    enabled: true,
    includeChildren: true,
    playSound: false,
    log: false,
    showToolbar: true,
    renderCountThreshold: 0,
    report: undefined,
    alwaysShowLabels: false,
    animationSpeed: 'fast',
    dangerouslyForceRunInProduction: false,
    smoothlyAnimateOutlines: true,
    trackUnnecessaryRenders: false,
  }),
  onRender: null,
  scheduledOutlines: new Map(),
  activeOutlines: new Map(),
  Store,
};

type LocalStorageOptions = Omit<
  Options,
  | 'onCommitStart'
  | 'onRender'
  | 'onCommitFinish'
  | 'onPaintStart'
  | 'onPaintFinish'
>;

const validateOptions = (options: Partial<Options>): Partial<Options> => {
  const errors: Array<string> = [];
  const validOptions: Partial<Options> = {};

  for (const key in options) {
    if (!isOptionKey(key)) continue;

    const value = options[key];
    switch (key) {
      case 'enabled':
      case 'includeChildren':
      case 'playSound':
      case 'log':
      case 'showToolbar':
      case 'report':
      case 'alwaysShowLabels':
      case 'dangerouslyForceRunInProduction':
        if (typeof value !== 'boolean') {
          errors.push(`- ${key} must be a boolean. Got "${value}"`);
        } else {
          validOptions[key] = value;
        }
        break;
      case 'renderCountThreshold':
      case 'resetCountTimeout':
        if (typeof value !== 'number' || value < 0) {
          errors.push(`- ${key} must be a non-negative number. Got "${value}"`);
        } else {
          validOptions[key] = value as number;
        }
        break;
      case 'animationSpeed':
        if (!['slow', 'fast', 'off'].includes(value as string)) {
          errors.push(
            `- Invalid animation speed "${value}". Using default "fast"`,
          );
        } else {
          validOptions[key] = value as 'slow' | 'fast' | 'off';
        }
        break;
      case 'onCommitStart':
        if (typeof value !== 'function') {
          errors.push(`- ${key} must be a function. Got "${value}"`);
        } else {
          validOptions.onCommitStart = value as () => void;
        }
        break;
      case 'onCommitFinish':
        if (typeof value !== 'function') {
          errors.push(`- ${key} must be a function. Got "${value}"`);
        } else {
          validOptions.onCommitFinish = value as () => void;
        }
        break;
      case 'onRender':
        if (typeof value !== 'function') {
          errors.push(`- ${key} must be a function. Got "${value}"`);
        } else {
          validOptions.onRender = value as (
            fiber: Fiber,
            renders: Array<Render>,
          ) => void;
        }
        break;
      case 'onPaintStart':
      case 'onPaintFinish':
        if (typeof value !== 'function') {
          errors.push(`- ${key} must be a function. Got "${value}"`);
        } else {
          validOptions[key] = value as (outlines: Array<Outline>) => void;
        }
        break;
      case 'trackUnnecessaryRenders': {
        validOptions.trackUnnecessaryRenders =
          typeof value === 'boolean' ? value : false;
        break;
      }
      case 'smoothlyAnimateOutlines': {
        validOptions.smoothlyAnimateOutlines =
          typeof value === 'boolean' ? value : false;
        break;
      }
      default:
        errors.push(`- Unknown option "${key}"`);
    }
  }

  if (errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole: Intended debug output
    console.warn(`[React Scan] Invalid options:\n${errors.join('\n')}`);
  }

  return validOptions;
};

// Type guard to ensure key is a valid option
function isOptionKey(key: string): key is keyof Options {
  return key in ReactScanInternals.options.value;
}

export const getReport = (type?: ComponentType<unknown>) => {
  if (type) {
    for (const reportData of Array.from(Store.legacyReportData.values())) {
      if (reportData.type === type) {
        return reportData;
      }
    }
    return null;
  }
  return Store.legacyReportData;
};

export const setOptions = (userOptions: Partial<Options>) => {
  const validOptions = validateOptions(userOptions);

  if (Object.keys(validOptions).length === 0) {
    return;
  }

  if ('playSound' in validOptions && validOptions.playSound) {
    validOptions.enabled = true;
  }

  const newOptions = {
    ...ReactScanInternals.options.value,
    ...validOptions,
  };

  const { instrumentation } = ReactScanInternals;
  if (instrumentation && 'enabled' in validOptions) {
    instrumentation.isPaused.value = validOptions.enabled === false;
  }

  ReactScanInternals.options.value = newOptions;

  saveLocalStorage('react-scan-options', newOptions);

  if ('showToolbar' in validOptions) {
    if (toolbarContainer && !newOptions.showToolbar) {
      toolbarContainer.remove();
    }

    if (newOptions.showToolbar && shadowRoot) {
      toolbarContainer = createToolbar(shadowRoot);
    }
  }
};

export const getOptions = () => ReactScanInternals.options;

export const reportRender = (fiber: Fiber, renders: Array<Render>) => {
  const reportFiber = fiber;
  const { selfTime } = getTimings(fiber);
  const displayName = getDisplayName(fiber.type);

  // Get data from both current and alternate fibers
  const currentData = Store.reportData.get(reportFiber);
  const alternateData = fiber.alternate
    ? Store.reportData.get(fiber.alternate)
    : null;

  // More efficient null checks and Math.max
  const existingCount = Math.max(
    currentData?.count ?? 0,
    alternateData?.count ?? 0,
  );

  // Create single shared object for both fibers
  const fiberData: RenderData = {
    count: existingCount + renders.length,
    time: selfTime || 0,
    renders,
    displayName,
    type: getType(fiber.type) || null,
  };

  // Store in both fibers
  Store.reportData.set(reportFiber, fiberData);
  if (fiber.alternate) {
    Store.reportData.set(fiber.alternate, fiberData);
  }

  if (displayName && ReactScanInternals.options.value.report) {
    const existingLegacyData = Store.legacyReportData.get(displayName) ?? {
      count: 0,
      time: 0,
      renders: [],
      displayName: null,
      type: getType(fiber.type) || fiber.type,
    };

    existingLegacyData.count = existingLegacyData.count + renders.length;
    existingLegacyData.time = existingLegacyData.time + (selfTime || 0);
    existingLegacyData.renders = renders;

    Store.legacyReportData.set(displayName, existingLegacyData);
  }

  Store.lastReportTime.value = Date.now();
};

export const isValidFiber = (fiber: Fiber) => {
  if (ignoredProps.has(fiber.memoizedProps)) {
    return false;
  }

  const allowList = ReactScanInternals.componentAllowList;
  const shouldAllow =
    allowList?.has(fiber.type) ?? allowList?.has(fiber.elementType);

  if (shouldAllow) {
    const parent = traverseFiber(
      fiber,
      (node) => {
        const options =
          allowList?.get(node.type) ?? allowList?.get(node.elementType);
        return options?.includeChildren;
      },
      true,
    );
    if (!parent && !shouldAllow) return false;
  }
  return true;
};
// we only need to run this check once and will read the value in hot path
let isProduction: boolean | null = null;
let rdtHook: ReturnType<typeof getRDTHook>;
export const getIsProduction = () => {
  if (isProduction !== null) {
    return isProduction;
  }
  rdtHook ??= getRDTHook();
  for (const renderer of rdtHook.renderers.values()) {
    const buildType = detectReactBuildType(renderer);
    if (buildType === 'production') {
      isProduction = true;
    }
  }
  return isProduction;
};

export const start = () => {
  if (typeof window === 'undefined') return;

  if (
    getIsProduction() &&
    !ReactScanInternals.options.value.dangerouslyForceRunInProduction
  ) {
    return;
  }

  const localStorageOptions =
    readLocalStorage<LocalStorageOptions>('react-scan-options');

  if (localStorageOptions) {
    const { enabled, playSound } = localStorageOptions;
    const validLocalOptions = validateOptions({ enabled, playSound });
    if (Object.keys(validLocalOptions).length > 0) {
      ReactScanInternals.options.value = {
        ...ReactScanInternals.options.value,
        ...validLocalOptions,
      };
    }
  }

  const instrumentation = createInstrumentation('devtools', {
    onActive() {
      const existingRoot = document.querySelector('react-scan-root');
      if (existingRoot) {
        return;
      }

      // Create audio context on first user interaction
      const createAudioContextOnInteraction = () => {
        audioContext = new (
          window.AudioContext ||
          // @ts-expect-error -- This is a fallback for Safari
          window.webkitAudioContext
        )();

        void audioContext.resume();
      };

      window.addEventListener('pointerdown', createAudioContextOnInteraction, {
        once: true,
      });

      const container = document.createElement('div');
      container.id = 'react-scan-root';

      shadowRoot = container.attachShadow({ mode: 'open' });

      const fragment = document.createDocumentFragment();

      const cssStyles = document.createElement('style');
      cssStyles.textContent = styles;

      const iconSprite = new DOMParser().parseFromString(
        svgSprite,
        'image/svg+xml',
      ).documentElement;
      shadowRoot.appendChild(iconSprite);

      const root = document.createElement('div');
      root.id = 'react-scan-toolbar-root';
      root.className = 'absolute z-2147483647';

      fragment.appendChild(cssStyles);
      fragment.appendChild(root);

      shadowRoot.appendChild(fragment);

      document.documentElement.appendChild(container);

      initReactScanOverlay();

      globalThis.__REACT_SCAN__ = {
        ReactScanInternals,
      };

      if (ReactScanInternals.options.value.showToolbar) {
        toolbarContainer = createToolbar(shadowRoot);
      }

      logIntro();
    },
    onCommitStart() {
      ReactScanInternals.options.value.onCommitStart?.();
    },
    onError(error) {
      // biome-ignore lint/suspicious/noConsole: Intended debug output
      console.error('[React Scan] Error instrumenting:', error);
    },
    isValidFiber,
    onRender(fiber, renders) {
      // todo: don't track renders at all if paused, reduce overhead

      const isPaused = ReactScanInternals.instrumentation?.isPaused.value;
      const isInspectInactive =
        Store.inspectState.value.kind === 'inspect-off' ||
        Store.inspectState.value.kind === 'uninitialized';
      const isTabHidden = document.visibilityState !== 'visible';

      if (isPaused || isInspectInactive || isTabHidden) {
        // don't draw if it's paused or tab is not active
        return;
      }

      updateFiberRenderData(fiber, renders);
      if (ReactScanInternals.options.value.log) {
        // this can be expensive given enough re-renders
        log(renders);
      }

      const shouldShowRenderReport = (fiber: Fiber) =>
        isCompositeFiber(fiber) &&
        ReactScanInternals.options.value.showToolbar !== false &&
        Store.inspectState.value.kind === 'focused';

      if (shouldShowRenderReport(fiber)) {
        reportRender(fiber, renders);
      }

      if (ReactScanInternals.options.value.log) {
        renders;
      }

      ReactScanInternals.options.value.onRender?.(fiber, renders);
      for (let i = 0, len = renders.length; i < len; i++) {
        const render = renders[i];

        if (ReactScanInternals.options.value.playSound && audioContext) {
          const renderTimeThreshold = 10;
          const amplitude = Math.min(
            1,
            ((render.time ?? 0) - renderTimeThreshold) /
              (renderTimeThreshold * 2),
          );
          playGeigerClickSound(audioContext, amplitude);
        }
      }
    },
    onCommitFinish() {
      ReactScanInternals.options.value.onCommitFinish?.();
    },
    trackChanges: true,
  });

  ReactScanInternals.instrumentation = instrumentation;

  // TODO: add an visual error indicator that it didn't load
  const isUsedInBrowserExtension = typeof window !== 'undefined';
  if (!Store.monitor.value && !isUsedInBrowserExtension) {
    setTimeout(() => {
      if (isInstrumentationActive()) return;
      // biome-ignore lint/suspicious/noConsole: Intended debug output
      console.error(
        '[React Scan] Failed to load. Must import React Scan before React runs.',
      );
    }, 5000);
  }
};

export const withScan = <T extends {}>(
  component: ComponentType<T>,
  options: Options = {},
) => {
  setOptions(options);
  const isInIframe = Store.isInIframe.value;
  const componentAllowList = ReactScanInternals.componentAllowList;
  if (isInIframe || (options.enabled === false && options.showToolbar !== true))
    return component;
  if (!componentAllowList) {
    ReactScanInternals.componentAllowList = new WeakMap<
      ComponentType<unknown>,
      Options
    >();
  }
  if (componentAllowList) {
    componentAllowList.set(component as ComponentType<unknown>, { ...options });
  }

  start();

  return component;
};

export const scan = (options: Options = {}) => {
  setOptions(options);
  const isInIframe = Store.isInIframe.value;
  if (isInIframe || (options.enabled === false && options.showToolbar !== true))
    return;

  start();
};

export const useScan = (options: Options = {}) => {
  setOptions(options);
  start();
};

export const onRender = (
  type: unknown,
  _onRender: (fiber: Fiber, renders: Array<Render>) => void,
) => {
  const prevOnRender = ReactScanInternals.onRender;
  ReactScanInternals.onRender = (fiber, renders) => {
    prevOnRender?.(fiber, renders);
    if (getType(fiber.type) === type) {
      _onRender(fiber, renders);
    }
  };
};

export const ignoredProps = new WeakSet<
  Exclude<ReactNode, undefined | null | string | number | boolean | bigint>
>();

export const ignoreScan = (node: ReactNode) => {
  if (typeof node === 'object' && node) {
    ignoredProps.add(node);
  }
};
